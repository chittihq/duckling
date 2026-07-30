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

    const ready = await waitFor(() => {
      sh(`docker exec ${CONTAINER} mysqladmin ping -uroot -p${ROOT_PASS} --silent 2>/dev/null`, 15_000);
      return true;
    }, 120_000, 2_000);
    if (!ready) throw new Error('MySQL container failed to become ready');

    // 2. Replication user with exactly the grants CDC-lite needs.
    mysqlInContainer(
      `CREATE USER '${REPL_USER}'@'%' IDENTIFIED BY '${REPL_PASS}'; ` +
      `GRANT SELECT ON ${DB}.* TO '${REPL_USER}'@'%'; ` +
      `GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '${REPL_USER}'@'%'; FLUSH PRIVILEGES;`,
    );
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
});
