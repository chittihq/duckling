/**
 * Suite Z2: S3 backup + restore round-trip end-to-end.
 *
 * Exercises the ClickHouse-native `BACKUP DATABASE ... TO S3(...)` /
 * `RESTORE DATABASE ... AS ... FROM S3(...)` flow against the local RustFS
 * (S3-compatible) instance brought up by run.sh under the `peerdb` profile.
 *
 * Flow:
 *  1. PUT /api/databases/default/s3-backup        — save credentials
 *  2. POST .../s3-backup/test                     — HeadBucket probe
 *  3. GET  .../backups                            — should be empty
 *  4. POST .../backups                            — take a backup
 *  5. GET  .../backups                            — should have one entry
 *  6. POST .../backups/restore { asDatabase }     — restore into a new CH db
 *     so we can verify the data without dropping the live `default`
 *  7. SELECT count() FROM <restored_db>.<table>   — verify rows match
 *  8. DROP DATABASE <restored_db>                 — clean up
 *  9. DELETE .../backups?key=...                  — remove backup from S3
 * 10. GET  .../backups                            — should be empty again
 * 11. DELETE .../s3-backup                        — clean up config
 *
 * Runs last alphabetically (`zsuite-s3-backup`) so the restore-into-shadow-db
 * doesn't perturb state earlier suites rely on, and so the polling default
 * database already has data from suite 1 by the time this fires.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { apiGet, apiPost, apiPut, apiDelete } from './helpers/api.js';
import { API_URL, API_KEY, DB_ID } from './helpers/config.js';

const BUCKET = 'duckling-test-backups';
const RUSTFS_ENDPOINT = 'http://rustfs:9000';
const RUSTFS_ACCESS_KEY = 'peerdb';
const RUSTFS_SECRET_KEY = 'peerdbsecret';
const RESTORE_TARGET_DB = 'default_restored_e2e';
const TIMEOUT_BACKUP_MS = 180_000;

async function clickhouseQuery(sql: string): Promise<any> {
  return apiPost(`/api/query?db=${DB_ID}`, { sql, database: 'clickhouse' });
}

async function scalar(sql: string, field: string): Promise<string> {
  const data = await clickhouseQuery(sql);
  const row = data?.result?.[0];
  if (!row) return 'null';
  const val = row[field];
  return val === null || val === undefined ? 'null' : String(val);
}

// Module-scoped state shared across the ordered tests in this suite.
let savedBackupKey: string | null = null;
let preBackupUserCount: number | null = null;

describe('Suite Z2: S3 backup + restore round-trip', () => {
  beforeAll(async () => {
    // Make sure the default db has data before we back it up. Previous suites
    // have already loaded it via suite 1, but be defensive in case test
    // ordering changes.
    try {
      await apiPost(`/sync/full?db=${DB_ID}`);
    } catch {
      // ignore — bootstrap may already be completed
    }
  }, 60_000);

  test('PUT /api/databases/:id/s3-backup saves config (secrets masked in response)', async () => {
    const res = await apiPut(`/api/databases/${DB_ID}/s3-backup`, {
      enabled: true,
      bucket: BUCKET,
      region: 'us-east-1',
      accessKeyId: RUSTFS_ACCESS_KEY,
      secretAccessKey: RUSTFS_SECRET_KEY,
      endpoint: RUSTFS_ENDPOINT,
      pathPrefix: `e2e-${Date.now()}/`,
      intervalHours: 0,     // manual only
      retentionDays: 0,     // never prune
    });
    expect(res?.success).toBe(true);
    expect(res?.s3Backup?.bucket).toBe(BUCKET);
    expect(res?.s3Backup?.endpoint).toBe(RUSTFS_ENDPOINT);
    expect(res?.s3Backup?.accessKeyId).toBe('***');
    expect(res?.s3Backup?.secretAccessKey).toBe('***');
  });

  test('GET /api/databases/:id/s3-backup returns the saved config', async () => {
    const res = await apiGet(`/api/databases/${DB_ID}/s3-backup`);
    expect(res?.success).toBe(true);
    expect(res?.s3Backup?.bucket).toBe(BUCKET);
    expect(res?.s3Backup?.enabled).toBe(true);
  });

  test('POST /api/databases/:id/s3-backup/test reaches the bucket', async () => {
    const res = await apiPost(`/api/databases/${DB_ID}/s3-backup/test`, {});
    expect(res?.success).toBe(true);
  });

  test('listBackups is empty before any backup runs', async () => {
    const res = await apiGet(`/api/databases/${DB_ID}/backups`);
    expect(res?.success).toBe(true);
    expect(Array.isArray(res?.backups)).toBe(true);
    expect(res?.backups.length).toBe(0);
  });

  test('record user-table row count before backup so we can verify after restore', async () => {
    const count = await scalar('SELECT count() AS c FROM users_with_timestamps', 'c');
    preBackupUserCount = Number(count);
    expect(preBackupUserCount).toBeGreaterThan(0);
  });

  test('POST /api/databases/:id/backups runs BACKUP DATABASE TO S3', async () => {
    const res = await apiPost(`/api/databases/${DB_ID}/backups`);
    expect(res?.success).toBe(true);
    expect(res?.backup?.name).toMatch(/^backup-/);
    expect(res?.backup?.key).toMatch(/\/$/);
    expect(typeof res?.backup?.durationMs).toBe('number');
    expect(res?.backup?.durationMs).toBeGreaterThanOrEqual(0);
    savedBackupKey = res.backup.key;
  }, TIMEOUT_BACKUP_MS);

  test('listBackups returns exactly one entry pointing at the backup we just took', async () => {
    const res = await apiGet(`/api/databases/${DB_ID}/backups`);
    expect(res?.success).toBe(true);
    expect(res?.backups.length).toBe(1);
    const [entry] = res.backups;
    expect(entry.key).toBe(savedBackupKey);
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(typeof entry.lastModified).toBe('string');
  });

  test('RESTORE DATABASE default AS default_restored_e2e succeeds', async () => {
    expect(savedBackupKey).not.toBeNull();
    // Ensure the target DB is gone from any prior aborted run.
    await clickhouseQuery(`DROP DATABASE IF EXISTS ${RESTORE_TARGET_DB}`).catch(() => {});

    const res = await apiPost(`/api/databases/${DB_ID}/backups/restore`, {
      key: savedBackupKey,
      asDatabase: RESTORE_TARGET_DB,
    });
    expect(res?.success).toBe(true);
    expect(typeof res?.restore?.durationMs).toBe('number');
  }, TIMEOUT_BACKUP_MS);

  test('restored database has the same rows as the source', async () => {
    expect(preBackupUserCount).not.toBeNull();
    // ClickHouse's SHOW TABLES / system.tables are cross-database; the
    // database we restored into is on the same server.
    const usersAfter = await scalar(
      `SELECT count() AS c FROM ${RESTORE_TARGET_DB}.users_with_timestamps`,
      'c',
    );
    expect(Number(usersAfter)).toBe(preBackupUserCount);

    // Also assert a known row landed intact.
    const aliceName = await scalar(
      `SELECT name AS n FROM ${RESTORE_TARGET_DB}.users_with_timestamps WHERE id = 1`,
      'n',
    );
    expect(aliceName).toBe('Alice');
  });

  test('cleanup: drop the restored database', async () => {
    await clickhouseQuery(`DROP DATABASE IF EXISTS ${RESTORE_TARGET_DB}`);
    // Verify it's gone.
    const stillThere = await scalar(
      `SELECT count() AS c FROM system.databases WHERE name = '${RESTORE_TARGET_DB}'`,
      'c',
    );
    expect(stillThere).toBe('0');
  });

  test('DELETE /api/databases/:id/backups removes the backup objects from S3', async () => {
    expect(savedBackupKey).not.toBeNull();
    const res = await apiDelete(
      `/api/databases/${DB_ID}/backups?key=${encodeURIComponent(savedBackupKey!)}`,
    );
    expect(res?.success).toBe(true);
    expect(res?.deletedObjects).toBeGreaterThan(0);
  });

  test('listBackups returns empty again after delete', async () => {
    const res = await apiGet(`/api/databases/${DB_ID}/backups`);
    expect(res?.success).toBe(true);
    expect(res?.backups.length).toBe(0);
  });

  test('delete + restore reject keys outside the configured prefix (400)', async () => {
    // Try to delete an object under a sibling prefix and restore from one.
    // The route is scoped to db `default`, whose prefix is `e2e-<ts>/` (see
    // PUT s3-backup above) — anything that doesn't start with that prefix
    // must be rejected.
    const foreignKey = 'someone-elses-database/backup-2026-01-01/';

    const delRes = await fetch(`${API_URL}/api/databases/${DB_ID}/backups?key=${encodeURIComponent(foreignKey)}`, {
      method: 'DELETE',
      headers: { Authorization: API_KEY },
    });
    expect(delRes.status).toBe(400);
    const delBody = await delRes.json();
    expect(delBody.success).toBe(false);
    expect(delBody.error).toMatch(/outside the configured prefix/);

    const restoreRes = await fetch(`${API_URL}/api/databases/${DB_ID}/backups/restore`, {
      method: 'POST',
      headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: foreignKey, asDatabase: 'should_never_be_created' }),
    });
    expect(restoreRes.status).toBe(400);
    const restoreBody = await restoreRes.json();
    expect(restoreBody.success).toBe(false);
    expect(restoreBody.error).toMatch(/outside the configured prefix/);

    // Side-effect check: the foreign-target DB was not created.
    const exists = await scalar(
      `SELECT count() AS c FROM system.databases WHERE name = 'should_never_be_created'`,
      'c',
    );
    expect(exists).toBe('0');
  });

  test('cleanup: DELETE /api/databases/:id/s3-backup removes the config', async () => {
    const res = await apiDelete(`/api/databases/${DB_ID}/s3-backup`);
    expect(res?.success).toBe(true);
    const after = await apiGet(`/api/databases/${DB_ID}/s3-backup`);
    expect(after?.s3Backup).toBe(null);
  });
});
