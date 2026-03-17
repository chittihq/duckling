import { afterEach, describe, expect, test, vi } from 'vitest';
import SequentialAppenderService from '../sequentialAppenderService';

describe('SequentialAppenderService incremental staging merge', () => {
  afterEach(() => {
    SequentialAppenderService.closeInstance('incremental-merge-test');
    SequentialAppenderService.closeInstance('incremental-merge-no-pk-test');
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
});
