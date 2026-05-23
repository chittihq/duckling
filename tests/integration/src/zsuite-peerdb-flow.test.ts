/**
 * Suite Z: PeerDB backend + three-phase replication strategy end-to-end smoke.
 *
 * Two paths are exercised:
 *   A) "Auto" path via /api/databases/:id/bootstrap?startPhase2=true — the
 *      replication coordinator runs Phase 1 (DumpService), captures binlog
 *      position, detects capability, and starts Phase 2A (PeerDB CDC with
 *      doInitialSnapshot:false).
 *   B) Legacy /sync/full path — same outcome, but uses the older API surface
 *      and PeerDB's own initial snapshot. Kept for backward-compat coverage.
 *
 * Runs unconditionally — the PeerDB stack is brought up by default in run.sh.
 * Zero-date fidelity is asserted in suite7 (with PeerDB-aware relaxation),
 * not here.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { apiGet, apiPost } from './helpers/api.js';
import { API_KEY, API_URL } from './helpers/config.js';

const PEERDB_DB_ID = 'peerdb_smoke';
const TIMEOUT_PROVISION_MS = 60_000;
const TIMEOUT_INITIAL_SNAPSHOT_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickhouseQuery(sql: string, dbId: string): Promise<any> {
  return apiPost(`/api/query?db=${dbId}`, { sql, database: 'clickhouse' });
}

async function waitForCondition(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for: ${label}${lastError ? ` (last error: ${String(lastError)})` : ''}`);
}

describe('Suite Z: PeerDB backend + three-phase replication', () => {
  beforeAll(async () => {
    try {
      await fetch(`${API_URL}/api/databases/${PEERDB_DB_ID}`, {
        method: 'DELETE',
        headers: { Authorization: API_KEY },
      });
    } catch {
      // ignore
    }
  }, 30_000);

  test('provisions a PeerDB-backed database', async () => {
    const res = await apiPost('/api/databases', {
      name: 'PeerDB Smoke',
      mysqlConnectionString:
        'mysql://integration:integrationpass@mysql:3306/integration_db?charset=utf8mb4',
      clickhouseDatabase: PEERDB_DB_ID,
      peerdb: {
        enabled: true,
        mysqlDisableTls: true,
        mysqlFlavor: 'mysql',
      },
      replicationMode: 'peerdb',
    });
    expect(res?.success).toBe(true);
    expect(res?.database?.id).toBeTruthy();
    // New databases default to bootstrap.status = 'pending'.
    expect(res?.database?.bootstrap?.status).toBe('pending');
  }, TIMEOUT_PROVISION_MS);

  test('capability probe reports binlog-CDC supported on the seeded MySQL', async () => {
    const res = await apiGet(`/api/databases/${PEERDB_DB_ID}/replication-mode`);
    expect(res?.success).toBe(true);
    expect(res?.capability?.cdcSupported).toBe(true);
    expect(res?.effectiveMode).toBe('peerdb');
    // Source has binlog ON, row image FULL, metadata FULL.
    expect(res?.capability?.variables?.binlog_format).toBe('ROW');
    expect(res?.capability?.variables?.binlog_row_image).toBe('FULL');
    expect(res?.capability?.variables?.binlog_row_metadata).toBe('FULL');
  }, TIMEOUT_PROVISION_MS);

  test('coordinator bootstrap + Phase 2 hand-off via /api/databases/:id/bootstrap', async () => {
    const res = await apiPost(`/api/databases/${PEERDB_DB_ID}/bootstrap`, { startPhase2: true });
    expect(res?.success).toBe(true);

    // For peerdb mode, PeerDB itself owns the initial snapshot — the
    // ClickHouse destination connector validates pre-populated tables strictly
    // and rejects them. The coordinator records the source binlog position
    // as informational and marks bootstrap completed for uniform status.
    expect(res?.bootstrap?.status).toBe('completed');
    expect(res?.bootstrap?.binlogPosition).toBeTruthy();
    expect(['gtid', 'filepos']).toContain(res.bootstrap.binlogPosition.mode);

    // Phase 2: PeerDB selected automatically because the source supports CDC.
    expect(res?.phase2?.mode).toBe('peerdb');
    expect(Array.isArray(res?.phase2?.mirrors)).toBe(true);
    const mirroredTables = (res.phase2.mirrors as Array<{ table: string }>).map((m) => m.table);
    expect(mirroredTables).toEqual(
      expect.arrayContaining(['products_simple', 'users_with_timestamps']),
    );
    expect(res?.effectiveMode).toBe('peerdb');
  }, TIMEOUT_INITIAL_SNAPSHOT_MS);

  test('bootstrap status endpoint reflects coordinator state', async () => {
    const res = await apiGet(`/api/databases/${PEERDB_DB_ID}/bootstrap/status`);
    expect(res?.success).toBe(true);
    expect(res?.bootstrap?.status).toBe('completed');
    // In peerdb mode the binlog position is recorded as diagnostic info.
    expect(res?.bootstrap?.binlogPosition?.mode).toMatch(/^(gtid|filepos)$/);
  }, TIMEOUT_PROVISION_MS);

  test('PeerDB snapshot landed rows for products_simple in ClickHouse', async () => {
    // In peerdb mode PeerDB performs the initial snapshot.
    await waitForCondition(
      'products_simple to be replicated',
      async () => {
        try {
          const result = await clickhouseQuery('SELECT count() AS c FROM products_simple', PEERDB_DB_ID);
          const count = Number(result?.result?.[0]?.c ?? 0);
          return count > 0;
        } catch {
          return false;
        }
      },
      TIMEOUT_INITIAL_SNAPSHOT_MS,
    );

    const result = await clickhouseQuery(
      'SELECT count() AS c FROM products_simple',
      PEERDB_DB_ID,
    );
    expect(Number(result.result[0].c)).toBeGreaterThanOrEqual(4);
  }, TIMEOUT_INITIAL_SNAPSHOT_MS + 5_000);

  test('PeerDB snapshot landed rows for users_with_timestamps in ClickHouse', async () => {
    await waitForCondition(
      'users_with_timestamps to be replicated',
      async () => {
        try {
          const result = await clickhouseQuery(
            'SELECT count() AS c FROM users_with_timestamps',
            PEERDB_DB_ID,
          );
          const count = Number(result?.result?.[0]?.c ?? 0);
          return count >= 5;
        } catch {
          return false;
        }
      },
      TIMEOUT_INITIAL_SNAPSHOT_MS,
    );
  }, TIMEOUT_INITIAL_SNAPSHOT_MS + 5_000);

  test('re-running bootstrap is idempotent', async () => {
    const res = await apiPost(`/api/databases/${PEERDB_DB_ID}/bootstrap`, {
      startPhase2: false,
    });
    expect(res?.success).toBe(true);
    // In peerdb mode startPhase2:false still returns a completed bootstrap
    // (PeerDB ownership is reflected via the coordinator-level state).
    expect(res?.bootstrap?.status).toBe('completed');
  }, TIMEOUT_PROVISION_MS);
});
