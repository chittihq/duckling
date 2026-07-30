import { describe, expect, test, vi } from 'vitest';

/**
 * The projection view must dedup BEFORE filtering _sync_deleted. If the
 * filter runs first, a tombstone (newer _sync_timestamp, _sync_deleted=1)
 * is removed from the window input and the OLDER live row still wins —
 * CDC-lite deletes could never take effect at read time.
 */

vi.mock('../../config', () => ({
  __esModule: true,
  default: {
    mysql: { maxConnections: 5 },
    sync: { excludedTables: [], batchSize: 1000, fullSyncBatchSize: 1000 },
    clickhouse: { finalReads: true, database: 'default' },
  },
}));
vi.mock('../../logger', () => ({
  __esModule: true,
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import ClickHouseSyncService from '../clickhouseSyncService';

const schema = [
  { Field: 'id', Key: 'PRI', Type: 'int(11)', Null: 'NO' },
  { Field: 'name', Key: '', Type: 'varchar(255)', Null: 'YES' },
];

function makeService(ranSql: string[], primaryKeys: string[], uniqueKeys: string[] = []): ClickHouseSyncService {
  const mysql = {
    getTableSchema: vi.fn(async () => schema),
    getPrimaryKeyColumns: vi.fn(async () => primaryKeys),
    getUniqueKeyColumns: vi.fn(async () => uniqueKeys),
  } as any;
  const clickhouse = {
    run: vi.fn(async (sql: string) => { ranSql.push(sql); }),
  } as any;
  // Bypass the singleton map — each test gets a fresh instance.
  return new (ClickHouseSyncService as any)(`tv-${Math.random()}`, mysql, clickhouse);
}

describe('tombstone-aware projection view', () => {
  test('keyed table: dedup window runs over ALL rows, delete-filter applies to the winner', async () => {
    const ran: string[] = [];
    await makeService(ran, ['id']).refreshProjectionView('users');

    expect(ran).toHaveLength(1);
    const sql = ran[0];
    expect(sql).toContain('CREATE OR REPLACE VIEW');
    expect(sql).toContain('row_number() OVER');
    // Winner-filter includes both conditions...
    expect(sql).toMatch(/_sync_row_num = 1 AND _sync_deleted = 0/);
    // ...and the window input is NOT pre-filtered on _sync_deleted: the only
    // _sync_deleted mention before the window close must be the projection of
    // the column itself, not a WHERE.
    const beforeWinnerFilter = sql.slice(0, sql.indexOf('_sync_row_num = 1'));
    expect(beforeWinnerFilter).not.toMatch(/WHERE\s+_sync_deleted/);
  });

  test('PK-less table with UNIQUE key still gets the tombstone-aware dedup view', async () => {
    const ran: string[] = [];
    await makeService(ran, [], ['email']).refreshProjectionView('users');
    expect(ran[0]).toContain('PARTITION BY `email`');
    expect(ran[0]).toMatch(/_sync_row_num = 1 AND _sync_deleted = 0/);
  });

  test('table with no key at all keeps the simple filtered view (no dedup possible)', async () => {
    const ran: string[] = [];
    await makeService(ran, [], []).refreshProjectionView('users');
    expect(ran[0]).not.toContain('row_number()');
    expect(ran[0]).toMatch(/WHERE\s+_sync_deleted = 0/);
  });
});
