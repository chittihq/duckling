import { describe, expect, test, vi, afterEach } from 'vitest';
import SequentialAppenderService from '../sequentialAppenderService';

async function* streamBatches(batches: any[][]) {
  for (const batch of batches) {
    yield batch;
  }
}

describe('SequentialAppenderService full sync transaction safety', () => {
  afterEach(() => {
    SequentialAppenderService.closeInstance('tx-test-sequential');
    SequentialAppenderService.closeInstance('tx-test-sequential-fail');
    SequentialAppenderService.closeInstance('tx-test-appender');
    vi.restoreAllMocks();
  });

  test('wraps DELETE + bulk INSERT in a transaction for sequential full sync', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const duckdb: any = {
      run: runMock,
      execute: vi.fn().mockResolvedValue([{ max_id: 1 }])
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(1),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 1, name: 'Alice' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-sequential', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableSequential('users');

    const queries = runMock.mock.calls.map(([query]) => query);
    expect(result.status).toBe('success');
    expect(queries).toContain('BEGIN TRANSACTION');
    expect(queries).toContain('COMMIT');
    expect(queries).not.toContain('ROLLBACK');

    const beginIndex = queries.indexOf('BEGIN TRANSACTION');
    const deleteIndex = queries.indexOf('DELETE FROM "users"');
    const commitIndex = queries.indexOf('COMMIT');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(beginIndex);
    expect(commitIndex).toBeGreaterThan(deleteIndex);
  });

  test('rolls back sequential full sync transaction when insert fails', async () => {
    const runMock = vi.fn().mockImplementation(async (query: string) => {
      if (query.startsWith('INSERT INTO "users"')) {
        throw new Error('insert failed');
      }
    });
    const duckdb: any = {
      run: runMock,
      execute: vi.fn().mockResolvedValue([])
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(1),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 1, name: 'Alice' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-sequential-fail', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableSequential('users');
    const queries = runMock.mock.calls.map(([query]) => query);

    expect(result.status).toBe('error');
    expect(queries).toContain('BEGIN TRANSACTION');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  test('uses staging table + transactional swap for appender full sync', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const duckdb: any = {
      run: runMock,
      execute: vi.fn().mockResolvedValue([{ max_id: 1 }]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      createAppender: vi.fn().mockResolvedValue({
        appender,
        connection: { closeSync: vi.fn() }
      })
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(1),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 1, name: 'Alice' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-appender', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    vi.spyOn(service, 'appendValueByType').mockImplementation(() => undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableSequentialWithAppender('users');
    const queries = runMock.mock.calls.map(([query]) => query);
    const createAppenderTable = duckdb.createAppender.mock.calls[0][0] as string;

    expect(result.status).toBe('success');
    expect(service.createTable).toHaveBeenCalledWith(
      createAppenderTable,
      expect.any(Array),
      { includePrimaryKey: false }
    );
    expect(createAppenderTable).toMatch(/^__full_sync_staging_users_[a-f0-9]{32}$/);
    expect(queries).toContain('BEGIN TRANSACTION');
    expect(queries).toContain('COMMIT');
    expect(queries).toContain('DELETE FROM "users"');
    expect(queries).toContain(`INSERT INTO "users" SELECT * FROM "${createAppenderTable}"`);
    expect(queries).toContain(`DROP TABLE IF EXISTS "${createAppenderTable}"`);
  });

  test('does not fail sync when staging cleanup drop fails after commit', async () => {
    const runMock = vi.fn().mockImplementation(async (query: string) => {
      if (query.startsWith('DROP TABLE IF EXISTS "__full_sync_staging_users_')) {
        throw new Error('drop failed');
      }
    });
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const duckdb: any = {
      run: runMock,
      execute: vi.fn().mockResolvedValue([{ max_id: 1 }]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      createAppender: vi.fn().mockResolvedValue({
        appender,
        connection: { closeSync: vi.fn() }
      })
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(1),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 1, name: 'Alice' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-appender', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    vi.spyOn(service, 'appendValueByType').mockImplementation(() => undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableSequentialWithAppender('users');
    const queries = runMock.mock.calls.map(([query]) => query);

    expect(result.status).toBe('success');
    expect(queries).toContain('COMMIT');
  });

  test('cleans orphan staging tables left by previous crashes before sync', async () => {
    const staleTable = '__full_sync_staging_users_deadbeefdeadbeefdeadbeefdeadbeef';
    const runMock = vi.fn().mockResolvedValue(undefined);
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const duckdb: any = {
      run: runMock,
      execute: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('FROM information_schema.tables')) {
          return [{ table_name: staleTable }];
        }
        return [{ max_id: 1 }];
      }),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      createAppender: vi.fn().mockResolvedValue({
        appender,
        connection: { closeSync: vi.fn() }
      })
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(1),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 1, name: 'Alice' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-appender', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'createTable').mockResolvedValue(undefined);
    vi.spyOn(service, 'appendValueByType').mockImplementation(() => undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);

    const result = await service.syncTableSequentialWithAppender('users');
    const queries = runMock.mock.calls.map(([query]) => query);

    expect(result.status).toBe('success');
    expect(queries).toContain(`DROP TABLE IF EXISTS "${staleTable}"`);
  });
});
