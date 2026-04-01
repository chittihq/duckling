import { describe, expect, test, vi, afterEach } from 'vitest';
import SequentialAppenderService from '../sequentialAppenderService';
import config from '../../config';

async function* streamBatches(batches: any[][]) {
  for (const batch of batches) {
    yield batch;
  }
}

/**
 * Build a runTransaction mock that delegates to the given runMock,
 * framing calls with BEGIN TRANSACTION / COMMIT / ROLLBACK so
 * existing query-sequence assertions keep working.
 */
function createRunTransactionMock(runMock: ReturnType<typeof vi.fn>) {
  return vi.fn(async (fn: (run: (sql: string, params?: any[]) => Promise<void>) => Promise<void>) => {
    await runMock('BEGIN TRANSACTION');
    try {
      await fn(async (sql: string, params?: any[]) => {
        await runMock(sql, params);
      });
      await runMock('COMMIT');
    } catch (error) {
      try { await runMock('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

function createDuckDBExecuteMock(columns: string[], fallbackRows: any[] = [{ max_id: 1 }]) {
  return vi.fn(async (query: string) => {
    if (query.includes('FROM information_schema.columns')) {
      return columns.map((column_name) => ({ column_name }));
    }
    return fallbackRows;
  });
}

describe('SequentialAppenderService full sync transaction safety', () => {
  afterEach(() => {
    SequentialAppenderService.closeInstance('tx-test-sequential');
    SequentialAppenderService.closeInstance('tx-test-sequential-fail');
    SequentialAppenderService.closeInstance('tx-test-appender');
    SequentialAppenderService.closeInstance('tx-test-appender-resume');
    SequentialAppenderService.closeInstance('tx-test-appender-swap-resume');
    vi.restoreAllMocks();
  });

  test('wraps DELETE + bulk INSERT in a transaction for sequential full sync', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const duckdb: any = {
      run: runMock,
      runTransaction: createRunTransactionMock(runMock),
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
      runTransaction: createRunTransactionMock(runMock),
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
      runTransaction: createRunTransactionMock(runMock),
      execute: createDuckDBExecuteMock(['name', 'id'], [{ max_id: 1 }]),
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
    expect(queries).toContain(`INSERT INTO "users" ("id", "name") SELECT "id", "name" FROM "${createAppenderTable}"`);
    expect(queries).toContain(`DROP TABLE IF EXISTS "${createAppenderTable}"`);
  });

  test('resumes appender full sync from an existing staging table and cursor', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const duckdb: any = {
      run: runMock,
      runTransaction: createRunTransactionMock(runMock),
      execute: createDuckDBExecuteMock(['id', 'name'], [{ max_id: 5 }]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      createAppender: vi.fn().mockResolvedValue({
        appender,
        connection: { closeSync: vi.fn() }
      })
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(10),
      streamTableData: vi.fn().mockReturnValue(streamBatches([[{ id: 4, name: 'Dave' }, { id: 5, name: 'Eve' }]]))
    };

    const service = SequentialAppenderService.getInstance('tx-test-appender-resume', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'prepareFullSyncSession').mockResolvedValue({
      tableName: 'users',
      sessionId: 'sess-1',
      stagingTable: '__full_sync_staging_users_resume1234',
      status: 'loading',
      pkColumns: ['id'],
      lastPkCursor: [3],
      recordsProcessed: 3,
      schemaFingerprint: 'fingerprint',
      errorMessage: null,
      startedAt: new Date('2026-03-21T00:00:00Z'),
      updatedAt: new Date('2026-03-21T00:00:00Z'),
      completedAt: null,
    });
    vi.spyOn(service, 'prepareResumedFullSyncStaging').mockResolvedValue(undefined);
    vi.spyOn(service, 'cleanupOrphanStagingTables').mockResolvedValue(undefined);
    vi.spyOn(service, 'appendValueByType').mockImplementation(() => undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);
    vi.spyOn(service, 'updateFullSyncSessionProgress').mockImplementation(async (_session: any, lastPkCursor: any[] | null, processed: number) => ({
      tableName: 'users',
      sessionId: 'sess-1',
      stagingTable: '__full_sync_staging_users_resume1234',
      status: 'loading',
      pkColumns: ['id'],
      lastPkCursor,
      recordsProcessed: processed,
      schemaFingerprint: 'fingerprint',
      errorMessage: null,
      startedAt: new Date('2026-03-21T00:00:00Z'),
      updatedAt: new Date('2026-03-21T00:00:00Z'),
      completedAt: null,
    }));
    vi.spyOn(service, 'updateFullSyncSessionStatus').mockImplementation(async (session: any, status: string) => ({
      ...session,
      status,
    }));
    const createTableSpy = vi.spyOn(service, 'createTable').mockResolvedValue(undefined);

    const result = await service.syncTableSequentialWithAppender('users');

    expect(result.status).toBe('success');
    expect(createTableSpy).not.toHaveBeenCalled();
    expect(service.prepareResumedFullSyncStaging).toHaveBeenCalled();
    expect(mysql.streamTableData).toHaveBeenCalledWith('users', config.sync.fullSyncBatchSize, [3]);
    expect(duckdb.createAppender).toHaveBeenCalledWith('__full_sync_staging_users_resume1234');
  });

  test('retries a swapping full sync session without rereading MySQL', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const duckdb: any = {
      run: runMock,
      runTransaction: createRunTransactionMock(runMock),
      execute: createDuckDBExecuteMock(['id', 'name'], [{ max_id: 5 }]),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      createAppender: vi.fn(),
    };
    const mysql: any = {
      getTableRowCountFast: vi.fn().mockResolvedValue(10),
      streamTableData: vi.fn(),
    };

    const service = SequentialAppenderService.getInstance('tx-test-appender-swap-resume', mysql, duckdb) as any;
    vi.spyOn(service, 'getSchemaOrCleanup').mockResolvedValue([
      { Field: 'id', Type: 'int', Key: 'PRI' },
      { Field: 'name', Type: 'varchar(255)', Key: '' }
    ]);
    vi.spyOn(service, 'ensureTableExists').mockResolvedValue(undefined);
    vi.spyOn(service, 'prepareFullSyncSession').mockResolvedValue({
      tableName: 'users',
      sessionId: 'sess-2',
      stagingTable: '__full_sync_staging_users_swap1234',
      status: 'swapping',
      pkColumns: ['id'],
      lastPkCursor: [5],
      recordsProcessed: 5,
      schemaFingerprint: 'fingerprint',
      errorMessage: null,
      startedAt: new Date('2026-03-21T00:00:00Z'),
      updatedAt: new Date('2026-03-21T00:00:00Z'),
      completedAt: null,
    });
    vi.spyOn(service, 'cleanupOrphanStagingTables').mockResolvedValue(undefined);
    vi.spyOn(service, 'getTableWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'detectPrimaryKeyColumn').mockResolvedValue('id');
    vi.spyOn(service, 'detectTimestampColumn').mockResolvedValue('updatedAt');
    vi.spyOn(service, 'updateWatermark').mockResolvedValue(undefined);
    vi.spyOn(service, 'logSyncOperation').mockResolvedValue(undefined);
    vi.spyOn(service, 'updateFullSyncSessionStatus').mockImplementation(async (session: any, status: string) => ({
      ...session,
      status,
    }));

    const result = await service.syncTableSequentialWithAppender('users');
    const queries = runMock.mock.calls.map(([query]) => query);

    expect(result.status).toBe('success');
    expect(mysql.streamTableData).not.toHaveBeenCalled();
    expect(duckdb.createAppender).not.toHaveBeenCalled();
    expect(queries).toContain('BEGIN TRANSACTION');
    expect(queries).toContain('COMMIT');
    expect(queries).toContain('DELETE FROM "users"');
    expect(queries).toContain('INSERT INTO "users" ("id", "name") SELECT "id", "name" FROM "__full_sync_staging_users_swap1234"');
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
      runTransaction: createRunTransactionMock(runMock),
      execute: createDuckDBExecuteMock(['id', 'name'], [{ max_id: 1 }]),
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

  test('ignores orphan staging tables left by previous crashes before sync', async () => {
    const staleTable = '__full_sync_staging_users_deadbeefdeadbeefdeadbeefdeadbeef';
    const runMock = vi.fn().mockResolvedValue(undefined);
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const duckdb: any = {
      run: runMock,
      runTransaction: createRunTransactionMock(runMock),
      execute: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('FROM information_schema.columns')) {
          return [
            { column_name: 'id' },
            { column_name: 'name' },
          ];
        }
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
    expect(queries).not.toContain(`DROP TABLE IF EXISTS "${staleTable}"`);
  });

  test('uses dedicated full sync batch settings for appender loads', async () => {
    const originalSyncConfig = { ...config.sync };
    const appender = {
      flushSync: vi.fn(),
      closeSync: vi.fn(),
      endRow: vi.fn()
    };
    const runMock = vi.fn().mockResolvedValue(undefined);
    const duckdb: any = {
      run: runMock,
      runTransaction: createRunTransactionMock(runMock),
      execute: createDuckDBExecuteMock(['id', 'name'], [{ max_id: 1 }]),
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

    Object.assign(config.sync, {
      batchSize: 5000,
      appenderFlushInterval: 5000,
      fullSyncBatchSize: 123,
      fullSyncAppenderFlushInterval: 321,
    });

    try {
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

      expect(result.status).toBe('success');
      expect(mysql.streamTableData).toHaveBeenCalledWith('users', 123, null);
    } finally {
      Object.assign(config.sync, originalSyncConfig);
    }
  });
});
