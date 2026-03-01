import { afterEach, describe, expect, test, vi } from 'vitest';
import SequentialAppenderService from '../sequentialAppenderService';

function successResult(tableName: string, recordsProcessed: number, syncType: 'sequential' | 'watermark') {
  return {
    table: tableName,
    recordsProcessed,
    duration: 1,
    status: 'success' as const,
    syncType,
  };
}

describe('SequentialAppenderService lock behavior', () => {
  afterEach(() => {
    SequentialAppenderService.closeInstance('lock-test-full');
    SequentialAppenderService.closeInstance('lock-test-incremental');
    SequentialAppenderService.closeInstance('lock-test-race');
    vi.restoreAllMocks();
  });

  test('fullSync skips tables that are already locked', async () => {
    const mysql: any = {
      getTables: vi.fn().mockResolvedValue(['users', 'orders']),
    };
    const duckdb: any = {};
    const service = SequentialAppenderService.getInstance('lock-test-full', mysql, duckdb) as any;

    vi.spyOn(service, 'cleanupDeletedTables').mockResolvedValue(undefined);
    const syncSpy = vi
      .spyOn(service, 'syncTableSequentialWithAppender')
      .mockImplementation(async (tableName: string) => successResult(tableName, 5, 'sequential'));

    (service as any).tableSyncLocks.add('users');
    const stats = await service.fullSync();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith('orders');
    expect(stats.totalTables).toBe(2);
    expect(stats.successfulTables).toBe(1);
    expect(stats.totalRecords).toBe(5);
    expect(service.isTableSyncInProgress('users')).toBe(true);
  });

  test('incrementalSync skips tables that are already locked', async () => {
    const mysql: any = {
      getTables: vi.fn().mockResolvedValue(['users', 'orders']),
    };
    const duckdb: any = {};
    const service = SequentialAppenderService.getInstance('lock-test-incremental', mysql, duckdb) as any;

    vi.spyOn(service, 'cleanupDeletedTables').mockResolvedValue(undefined);
    const syncSpy = vi
      .spyOn(service, 'syncTableWatermark')
      .mockImplementation(async (tableName: string) => successResult(tableName, 7, 'watermark'));

    (service as any).tableSyncLocks.add('users');
    const stats = await service.incrementalSync();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith('orders');
    expect(stats.totalTables).toBe(2);
    expect(stats.successfulTables).toBe(1);
    expect(stats.totalRecords).toBe(7);
    expect(service.isTableSyncInProgress('users')).toBe(true);
  });

  test('single-table sync is rejected when batch sync is already processing the same table', async () => {
    const mysql: any = {
      getTables: vi.fn().mockResolvedValue(['users']),
    };
    const duckdb: any = {};
    const service = SequentialAppenderService.getInstance('lock-test-race', mysql, duckdb) as any;

    vi.spyOn(service, 'cleanupDeletedTables').mockResolvedValue(undefined);
    const syncSpy = vi
      .spyOn(service, 'syncTableSequentialWithAppender')
      .mockImplementation(async (tableName: string) => {
        await expect(service.syncSingleTable(tableName)).rejects.toThrow(
          `Sync already in progress for table '${tableName}'. Please wait for it to complete.`
        );
        return successResult(tableName, 3, 'sequential');
      });

    const stats = await service.fullSync();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(stats.successfulTables).toBe(1);
    expect(service.isTableSyncInProgress('users')).toBe(false);
  });
});
