import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import { vi } from 'vitest';

/**
 * LIVE CDC-lite test: provisions a real MySQL instance configured with
 * exactly the specification CDC-lite requires —
 *
 *   log_bin              = ON
 *   binlog_format        = ROW
 *   binlog_row_image     = FULL
 *   binlog_row_metadata  = MINIMAL   <-- deliberately: the managed-MySQL
 *                                        default that full PeerDB CDC cannot
 *                                        serve; CDC-lite's reason to exist
 *   gtid_mode            = ON
 *   user with REPLICATION SLAVE + REPLICATION CLIENT
 *
 * — then runs the REAL BinlogTailerService (real zongji, real binlog stream,
 * real MySQLConnection) against it. Only the ClickHouse side is mocked, so
 * tombstone writes and sync nudges are captured and asserted.
 *
 * Skips when no Docker daemon is reachable. Supports DOCKER_HOST=ssh://<alias>
 * (remote daemon) by opening an SSH port-forward for the MySQL port, same as
 * tests/integration/run.sh.
 */

const CONTAINER = 'duckling-cdclite-unit-mysql';
const HOST_PORT = 23310;
const ROOT_PASS = 'cdclite-root';
const DB = 'cdclite';
const REPL_USER = 'cdclite_repl';
const REPL_PASS = 'cdclite-pass';

function sh(cmd: string, timeoutMs = 60_000): string {
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

function dockerAvailable(): boolean {
  try {
    sh('docker info --format "{{.ServerVersion}}"', 20_000);
    return true;
  } catch {
    return false;
  }
}

function sshAliasFromDockerHost(): string | null {
  const dockerHost = process.env.DOCKER_HOST || '';
  return dockerHost.startsWith('ssh://') ? dockerHost.slice('ssh://'.length) : null;
}

const DOCKER_OK = dockerAvailable();

function mysqlInContainer(sql: string, database = ''): string {
  const dbArg = database ? ` ${database}` : '';
  return sh(
    `docker exec ${CONTAINER} mysql -uroot -p${ROOT_PASS}${dbArg} -N -e ${JSON.stringify(sql)} 2>/dev/null`,
    30_000,
  ).trim();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe.skipIf(!DOCKER_OK)('CDC-lite against a real spec-exact MySQL instance', () => {
  let tunnel: ChildProcess | null = null;
  let mysqlConn: any = null;
  let tailer: any = null;
  let BinlogTailerServiceClass: any;

  const capturedInserts: Array<{ table: string; rows: any[]; columns?: string[] }> = [];
  const nudgedTables: string[] = [];

  // The tailer also persists its checkpoint via clickhouse.insert
  // (cdc_binlog_position) — only `<table>__raw` writes are tombstones.
  const tombstoneInserts = (): Array<{ table: string; rows: any[]; columns?: string[] }> =>
    capturedInserts.filter((entry) => entry.table === 'widgets__raw');
  const tombstoneIds = (): number[] =>
    tombstoneInserts().flatMap((entry) => entry.rows).map((row) => Number(row.id));

  const clickhouseMock = {
    execute: vi.fn(async () => []),          // no stored checkpoint -> start from now
    insert: vi.fn(async (table: string, rows: any[], columns?: string[]) => {
      capturedInserts.push({ table, rows, columns });
    }),
    run: vi.fn(async () => undefined),
  };
  const syncServiceMock = {
    refreshProjectionView: vi.fn(async () => undefined),
    syncSingleTable: vi.fn(async (table: string) => {
      nudgedTables.push(table);
      return { status: 'success', recordsProcessed: 1 };
    }),
  };

  beforeAll(async () => {
    // 1. A fresh MySQL with the exact CDC-lite spec, flags passed explicitly.
    sh(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
    sh(
      `docker run -d --name ${CONTAINER} ` +
      `-e MYSQL_ROOT_PASSWORD=${ROOT_PASS} -e MYSQL_DATABASE=${DB} ` +
      `-p ${HOST_PORT}:3306 mysql:8.4 ` +
      '--log-bin=binlog --binlog-format=ROW --binlog-row-image=FULL ' +
      '--binlog-row-metadata=MINIMAL ' +
      '--gtid-mode=ON --enforce-gtid-consistency=ON --server-id=1',
      120_000,
    );

    // Readiness must be a real query against the FINAL server. `mysqladmin
    // ping` answers during the image's init phase too — the entrypoint runs a
    // temporary server, then restarts it — so pinging alone lets setup race
    // the restart and fail with a connection error mid-statement.
    const ready = await waitFor(() => {
      sh(`docker exec ${CONTAINER} mysql -uroot -p${ROOT_PASS} -N -e "SELECT 1" ${DB} 2>/dev/null`, 15_000);
      return true;
    }, 180_000, 2_000);
    if (!ready) throw new Error('MySQL container failed to become ready');

    // 2. Replication user with exactly the grants CDC-lite needs. Idempotent
    // and retried: a leftover user (or a restart landing between statements)
    // must not fail the whole suite.
    const granted = await waitFor(() => {
      mysqlInContainer(
        `DROP USER IF EXISTS '${REPL_USER}'@'%'; ` +
        `CREATE USER '${REPL_USER}'@'%' IDENTIFIED BY '${REPL_PASS}'; ` +
        `GRANT SELECT ON ${DB}.* TO '${REPL_USER}'@'%'; ` +
        `GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '${REPL_USER}'@'%'; FLUSH PRIVILEGES;`,
      );
      return true;
    }, 60_000, 2_000);
    if (!granted) throw new Error('failed to provision the replication user');
    mysqlInContainer(
      'CREATE TABLE widgets (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL); ' +
      "INSERT INTO widgets VALUES (1, 'one'), (2, 'two'), (3, 'three');",
      DB,
    );

    // 3. Remote docker daemon? Tunnel the published port locally.
    const sshAlias = sshAliasFromDockerHost();
    if (sshAlias) {
      tunnel = spawn('ssh', ['-N', '-L', `${HOST_PORT}:127.0.0.1:${HOST_PORT}`, sshAlias], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    // 4. Real MySQLConnection + real tailer; only ClickHouse-side mocked.
    const { default: MySQLConnection } = await import('../../database/mysql');
    const { default: BinlogTailerService } = await import('../binlogTailerService');
    BinlogTailerServiceClass = BinlogTailerService;

    mysqlConn = new MySQLConnection(
      `mysql://${REPL_USER}:${REPL_PASS}@127.0.0.1:${HOST_PORT}/${DB}`,
    );

    const connectable = await waitFor(async () => {
      await mysqlConn.execute('SELECT 1');
      return true;
    }, 30_000, 1_000);
    if (!connectable) throw new Error(`Cannot reach MySQL on 127.0.0.1:${HOST_PORT} (tunnel: ${Boolean(tunnel)})`);
  }, 240_000);

  afterAll(async () => {
    if (tailer && BinlogTailerServiceClass) {
      await BinlogTailerServiceClass.closeInstance('cdclite-live').catch(() => undefined);
    }
    if (mysqlConn) await mysqlConn.close().catch(() => undefined);
    if (tunnel) tunnel.kill();
    try {
      sh(`docker rm -f ${CONTAINER}`, 30_000);
    } catch {
      // container may already be gone
    }
  }, 60_000);

  test('the instance matches the CDC-lite required specification exactly', async () => {
    const vars = new Map<string, string>();
    const rows = await mysqlConn.execute(
      "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('log_bin','binlog_format','binlog_row_image','binlog_row_metadata','gtid_mode')",
    );
    for (const row of rows) vars.set(row.Variable_name, row.Value);

    expect(vars.get('log_bin')).toBe('ON');
    expect(vars.get('binlog_format')).toBe('ROW');
    expect(vars.get('binlog_row_image')).toBe('FULL');
    // The deliberate part: MINIMAL — the config full PeerDB CDC rejects.
    expect(vars.get('binlog_row_metadata')).toBe('MINIMAL');
    expect(vars.get('gtid_mode')).toBe('ON');

    const grants = (await mysqlConn.execute('SHOW GRANTS FOR CURRENT_USER()'))
      .map((r: any) => String(Object.values(r)[0])).join(' ');
    expect(grants).toContain('REPLICATION SLAVE');
    expect(grants).toContain('REPLICATION CLIENT');
  }, 30_000);

  test('tailer connects to the real binlog stream', async () => {
    tailer = BinlogTailerServiceClass.getInstance('cdclite-live', mysqlConn, clickhouseMock, syncServiceMock);
    await tailer.start();

    const running = await waitFor(() => tailer.getStatus().running === true, 30_000, 500);
    expect(running).toBe(true);
    // View refresh sweep ran against the real table list.
    expect(syncServiceMock.refreshProjectionView).toHaveBeenCalledWith('widgets');
  }, 60_000);

  test('INSERT on the source triggers a sync nudge', async () => {
    mysqlInContainer("INSERT INTO widgets VALUES (4, 'four');", DB);
    const nudged = await waitFor(() => nudgedTables.includes('widgets'), 20_000, 250);
    expect(nudged).toBe(true);
  }, 30_000);

  test('DELETE on the source produces a tombstone with the real PK value', async () => {
    mysqlInContainer('DELETE FROM widgets WHERE id = 2;', DB);

    const arrived = await waitFor(() => tombstoneInserts().length > 0, 20_000, 250);
    expect(arrived).toBe(true);

    const { rows, columns } = tombstoneInserts()[0];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(2);
    expect(rows[0]._sync_deleted).toBe(1);
    expect(rows[0].name).toBeUndefined();            // dedup-key + sync cols only
    expect(columns).toEqual(expect.arrayContaining(['id', '_sync_deleted']));
    expect(tailer.getStatus().tombstonesWritten).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('multi-row DELETE tombstones every affected row', async () => {
    mysqlInContainer('DELETE FROM widgets WHERE id IN (3, 4);', DB);

    const arrived = await waitFor(
      () => tombstoneIds().includes(3) && tombstoneIds().includes(4),
      20_000,
      250,
    );
    expect(arrived).toBe(true);
    // Exactly one tombstone per deleted row (ids 2, 3, 4 deleted so far).
    expect([...tombstoneIds()].sort()).toEqual([2, 3, 4]);
  }, 30_000);

  test('GTID checkpoint is captured from the live stream', async () => {
    const hasGtid = await waitFor(() => {
      const status = tailer.getStatus();
      return typeof status.gtidSet === 'string' && status.gtidSet.length > 0;
    }, 15_000, 500);
    expect(hasGtid).toBe(true);
  }, 20_000);

  // ── Full operation matrix under MINIMAL metadata ─────────────────────────

  test('UPDATE on the source triggers a sync nudge', async () => {
    const nudgesBefore = nudgedTables.filter((t) => t === 'widgets').length;
    mysqlInContainer("UPDATE widgets SET name = 'one-renamed' WHERE id = 1;", DB);
    const nudged = await waitFor(
      () => nudgedTables.filter((t) => t === 'widgets').length > nudgesBefore,
      20_000,
      250,
    );
    expect(nudged).toBe(true);
  }, 30_000);

  test('composite-PK table: DELETE tombstones carry every key column', async () => {
    mysqlInContainer(
      'CREATE TABLE order_lines (order_id INT, line_no INT, sku VARCHAR(32), PRIMARY KEY (order_id, line_no)); ' +
      "INSERT INTO order_lines VALUES (100, 1, 'a'), (100, 2, 'b');",
      DB,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    mysqlInContainer('DELETE FROM order_lines WHERE order_id = 100 AND line_no = 2;', DB);

    const arrived = await waitFor(
      () => capturedInserts.some((entry) => entry.table === 'order_lines__raw'),
      20_000,
      250,
    );
    expect(arrived).toBe(true);
    const row = capturedInserts.find((entry) => entry.table === 'order_lines__raw')!.rows[0];
    expect(Number(row.order_id)).toBe(100);
    expect(Number(row.line_no)).toBe(2);
    expect(row.sku).toBeUndefined();
    expect(row._sync_deleted).toBe(1);
  }, 30_000);

  test('ALTER TABLE adding a column: subsequent DELETE still tombstones correctly', async () => {
    mysqlInContainer('ALTER TABLE widgets ADD COLUMN color VARCHAR(16) DEFAULT NULL;', DB);
    mysqlInContainer("INSERT INTO widgets (id, name, color) VALUES (10, 'ten', 'red');", DB);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const before = tombstoneIds().length;
    mysqlInContainer('DELETE FROM widgets WHERE id = 10;', DB);
    const arrived = await waitFor(() => tombstoneIds().length > before, 20_000, 250);
    expect(arrived).toBe(true);
    expect(tombstoneIds()).toContain(10);
  }, 30_000);

  test('ALTER TABLE changing the PRIMARY KEY: tombstones switch to the new key', async () => {
    mysqlInContainer(
      'CREATE TABLE rekeyed (id INT PRIMARY KEY, code VARCHAR(16) NOT NULL UNIQUE); ' +
      "INSERT INTO rekeyed VALUES (1, 'aa'), (2, 'bb');",
      DB,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Warm the dedup-key cache with the OLD key.
    mysqlInContainer('DELETE FROM rekeyed WHERE id = 1;', DB);
    await waitFor(() => capturedInserts.some((entry) => entry.table === 'rekeyed__raw'), 20_000, 250);

    // Change the PK — the DDL query event must invalidate the cached key.
    mysqlInContainer('ALTER TABLE rekeyed DROP PRIMARY KEY, DROP INDEX code, ADD PRIMARY KEY (code);', DB);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    mysqlInContainer("DELETE FROM rekeyed WHERE code = 'bb';", DB);

    const arrived = await waitFor(
      () => capturedInserts.filter((entry) => entry.table === 'rekeyed__raw')
        .flatMap((entry) => entry.rows).some((row) => row.code === 'bb'),
      20_000,
      250,
    );
    expect(arrived).toBe(true);
    const newTombstone = capturedInserts.filter((entry) => entry.table === 'rekeyed__raw')
      .flatMap((entry) => entry.rows).find((row) => row.code === 'bb')!;
    expect(newTombstone.id).toBeUndefined();   // keyed on the NEW pk, not the stale one
  }, 40_000);

  test('temporary tables and views generate no row events and break nothing', async () => {
    const tombstonesBefore = tombstoneIds().length;
    const nudgesBefore = nudgedTables.length;
    // Temp-table writes and view DDL are not row-logged in ROW binlog mode.
    mysqlInContainer(
      'CREATE TEMPORARY TABLE scratch (x INT); INSERT INTO scratch VALUES (1), (2); ' +
      'CREATE OR REPLACE VIEW widgets_view AS SELECT id, name FROM widgets;',
      DB,
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(tombstoneIds().length).toBe(tombstonesBefore);
    expect(nudgedTables.length).toBe(nudgesBefore);

    // Stream is still healthy afterwards: a real delete still tombstones.
    mysqlInContainer("INSERT INTO widgets (id, name) VALUES (11, 'eleven');", DB);
    await new Promise((resolve) => setTimeout(resolve, 500));
    mysqlInContainer('DELETE FROM widgets WHERE id = 11;', DB);
    const arrived = await waitFor(() => tombstoneIds().includes(11), 20_000, 250);
    expect(arrived).toBe(true);
  }, 40_000);

  test('rolled-back transaction produces NO tombstone', async () => {
    const before = tombstoneIds().length;
    mysqlInContainer('SET autocommit=0; BEGIN; DELETE FROM widgets WHERE id = 1; ROLLBACK;', DB);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(tombstoneIds().length).toBe(before);
    // The row is genuinely still there on the source.
    expect(mysqlInContainer('SELECT COUNT(*) FROM widgets WHERE id = 1;', DB)).toBe('1');
  }, 30_000);

  test('TRUNCATE emits no row events and the stream survives it', async () => {
    mysqlInContainer("CREATE TABLE trunc_me (id INT PRIMARY KEY); INSERT INTO trunc_me VALUES (1), (2), (3);", DB);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const before = capturedInserts.filter((entry) => entry.table === 'trunc_me__raw').length;
    mysqlInContainer('TRUNCATE TABLE trunc_me;', DB);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    // No deleterows for TRUNCATE — the poller's count-drop rebuild owns this case.
    expect(capturedInserts.filter((entry) => entry.table === 'trunc_me__raw').length).toBe(before);

    // Stream alive: inserts on another table still nudge.
    const nudgesBefore = nudgedTables.filter((t) => t === 'widgets').length;
    mysqlInContainer("INSERT INTO widgets (id, name) VALUES (12, 'twelve');", DB);
    const nudged = await waitFor(
      () => nudgedTables.filter((t) => t === 'widgets').length > nudgesBefore,
      20_000,
      250,
    );
    expect(nudged).toBe(true);
  }, 40_000);
});
