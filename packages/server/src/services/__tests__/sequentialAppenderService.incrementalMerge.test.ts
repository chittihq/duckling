import { afterEach, describe, expect, test, vi } from 'vitest';
import SequentialAppenderService from '../sequentialAppenderService';

describe('SequentialAppenderService incremental staging merge', () => {
  afterEach(() => {
    SequentialAppenderService.closeInstance('incremental-merge-test');
    SequentialAppenderService.closeInstance('incremental-merge-no-pk-test');
    SequentialAppenderService.closeInstance('incremental-merge-startup-cleanup-test');
    SequentialAppenderService.closeInstance('incremental-merge-empty-stream-test');
    vi.restoreAllMocks();
  });

  test('stages incremental rows with appender and merges them by primary key', async () => {
    const mysql: any = {
      streamIncrementalData: vi.fn(async function* () {
        yield [
          { id: 1, name: 'Alice', updatedAt: '2026-03-17 10:00:00' },
          { id: 2, name: 'Bob', updatedAt: '2026-03-17 10:01:00' },
        ];
      }),
    };

    const appender = {
      appendBigInt: vi.fn(),
      appendVarchar: vi.fn(),
      appendTimestamp: vi.fn(),
      endRow: vi.fn(),
      flushSync: vi.fn(),
      closeSync: vi.fn(),
    };
    const conn = { closeSync: vi.fn() };
    const duckdb: any = {
      createAppender: vi.fn(async () => ({ appender, connection: conn })),
      run: vi.fn(async () => undefined),
    };

    const service = SequentialAppenderService.getInstance('incremental-merge-test', mysql, duckdb) as any;

    vi.spyOn(service, 'getTableWatermark').mockResolvedValue({
      lastProcessedId: 0,
      lastProcessedTimestamp: new Date('2026-03-17T09:00:00Z'),
      primaryKeyColumn: 'id',
      timestampColumn: 'updatedAt',
      updatedAt: new Date(),
    });
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' },
      { Field: 'updatedAt', Type: 'datetime', Key: '' },
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'cleanupOrphanStagingTables').mockResolvedValue(undefined);
    vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableWatermark('users');

    expect(result.status).toBe('success');
    expect(result.recordsProcessed).toBe(2);
    expect(duckdb.createAppender).toHaveBeenCalledTimes(1);
    expect(service.createTable).toHaveBeenCalledWith(
      expect.stringMatching(/^__full_sync_staging_users_[a-f0-9]{32}$/),
      expect.any(Array),
      { includePrimaryKey: false }
    );

    const runSql = duckdb.run.mock.calls.map((call: any[]) => call[0]);
    expect(runSql).toContain('BEGIN TRANSACTION');
    expect(runSql.some((sql: string) => sql.includes('DELETE FROM "users" AS target USING "'))).toBe(true);
    expect(runSql).toContainEqual(expect.stringContaining('INSERT INTO "users" SELECT * FROM "'));
    expect(runSql).toContain('COMMIT');
    expect(runSql.some((sql: string) => sql.includes('INSERT OR REPLACE INTO "users"'))).toBe(false);
  });

  test('falls back to sequential appender sync when incremental table has no primary key', async () => {
    const mysql: any = {};
    const duckdb: any = {};
    const service = SequentialAppenderService.getInstance('incremental-merge-no-pk-test', mysql, duckdb) as any;

    vi.spyOn(service, 'getTableWatermark').mockResolvedValue({
      lastProcessedTimestamp: new Date('2026-03-17T09:00:00Z'),
      primaryKeyColumn: undefined,
      timestampColumn: 'updatedAt',
      updatedAt: new Date(),
    });
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'name', Type: 'varchar(255)', Key: '' },
      { Field: 'updatedAt', Type: 'datetime', Key: '' },
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    const sequentialSpy = vi
      .spyOn(service, 'syncTableSequentialWithAppender')
      .mockResolvedValue({
        table: 'events',
        recordsProcessed: 5,
        duration: 1,
        status: 'success',
        syncType: 'sequential',
      });

    const result = await service.syncTableWatermark('events');

    expect(sequentialSpy).toHaveBeenCalledWith('events');
    expect(result.syncType).toBe('sequential');
  });

  test('ignores unrelated orphan staging tables once after restart before incremental sync', async () => {
    const unrelatedStaleTable = '__full_sync_staging_orders_deadbeefdeadbeefdeadbeefdeadbeef';
    const mysql: any = {
      streamIncrementalData: vi.fn(async function* () {
        yield [
          { id: 1, name: 'Alice', updatedAt: '2026-03-17 10:00:00' },
        ];
      }),
    };

    const appender = {
      appendBigInt: vi.fn(),
      appendVarchar: vi.fn(),
      appendTimestamp: vi.fn(),
      endRow: vi.fn(),
      flushSync: vi.fn(),
      closeSync: vi.fn(),
    };
    const conn = { closeSync: vi.fn() };
    const duckdb: any = {
      createAppender: vi.fn(async () => ({ appender, connection: conn })),
      run: vi.fn(async () => undefined),
      execute: vi.fn(async (query: string) => {
        if (query.includes("substr(table_name, 1, 20) = '__full_sync_staging_'")) {
          return [{ table_name: unrelatedStaleTable }];
        }
        if (query.includes('substr(table_name, 1, ?) = ?')) {
          return [];
        }
        return [];
      }),
    };

    const service = SequentialAppenderService.getInstance('incremental-merge-startup-cleanup-test', mysql, duckdb) as any;

    vi.spyOn(service, 'getTableWatermark').mockResolvedValue({
      lastProcessedId: 0,
      lastProcessedTimestamp: new Date('2026-03-17T09:00:00Z'),
      primaryKeyColumn: 'id',
      timestampColumn: 'updatedAt',
      updatedAt: new Date(),
    });
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' },
      { Field: 'updatedAt', Type: 'datetime', Key: '' },
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableWatermark('users');
    const runSql = duckdb.run.mock.calls.map((call: any[]) => call[0]);

    expect(result.status).toBe('success');
    expect(runSql).not.toContain(`DROP TABLE IF EXISTS "${unrelatedStaleTable}"`);
  });

  test('does not create a staging table until the first incremental batch arrives', async () => {
    const sameTableStaleTable = '__full_sync_staging_users_deadbeefdeadbeefdeadbeefdeadbeef';
    const mysql: any = {
      streamIncrementalData: vi.fn(async function* () {
        return;
      }),
    };

    const duckdb: any = {
      createAppender: vi.fn(async () => ({ appender: {}, connection: {} })),
      run: vi.fn(async () => undefined),
      execute: vi.fn(async (query: string) => {
        if (query.includes("substr(table_name, 1, 20) = '__full_sync_staging_'")) {
          return [{ table_name: sameTableStaleTable }];
        }
        if (query.includes('substr(table_name, 1, ?) = ?')) {
          return [{ table_name: sameTableStaleTable }];
        }
        return [];
      }),
    };

    const service = SequentialAppenderService.getInstance('incremental-merge-empty-stream-test', mysql, duckdb) as any;

    vi.spyOn(service, 'getTableWatermark').mockResolvedValue({
      lastProcessedId: 0,
      lastProcessedTimestamp: new Date('2026-03-17T09:00:00Z'),
      primaryKeyColumn: 'id',
      timestampColumn: 'updatedAt',
      updatedAt: new Date(),
    });
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' },
      { Field: 'updatedAt', Type: 'datetime', Key: '' },
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    const createTableSpy = vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    const updateWatermarkSpy = vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableWatermark('users');

    expect(result.status).toBe('success');
    expect(result.recordsProcessed).toBe(0);
    expect(createTableSpy).not.toHaveBeenCalled();
    expect(duckdb.createAppender).not.toHaveBeenCalled();
    expect(updateWatermarkSpy).not.toHaveBeenCalled();
  });

  test('cleanupDeletedTables ignores internal staging tables', async () => {
    const staleTable = '__full_sync_staging_orders_deadbeefdeadbeefdeadbeefdeadbeef';
    const duckdb: any = {
      getTables: vi.fn().mockResolvedValue([staleTable, 'users']),
      run: vi.fn(async () => undefined),
    };

    const service = SequentialAppenderService.getInstance('incremental-merge-startup-cleanup-test', {} as any, duckdb) as any;

    await service.cleanupDeletedTables([]);

    const runSql = duckdb.run.mock.calls.map((call: any[]) => call[0]);
    expect(runSql).toContain('DROP TABLE IF EXISTS "users"');
    expect(runSql).not.toContain(`DROP TABLE IF EXISTS "${staleTable}"`);
  });
});
