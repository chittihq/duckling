import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import AutomationService from '../automationService';

describe('AutomationService scheduling guards', () => {
  const databaseId = 'test-automation-guards';

  beforeEach(() => {
    AutomationService.closeInstance(databaseId);
  });

  afterEach(() => {
    AutomationService.closeInstance(databaseId);
    vi.restoreAllMocks();
  });

  test('skips automatic backup while sync is in progress', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn(),
    };

    const duckdbMock = {
      checkpoint: vi.fn(),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      duckdbMock as any,
      { query: vi.fn() } as any
    );

    (service as any).isSyncInProgress = true;
    await (service as any).performBackup();

    expect(duckdbMock.checkpoint).not.toHaveBeenCalled();
  });

  test('skips scheduled incremental sync while backup is in progress', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn(),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      { checkpoint: vi.fn() } as any,
      { query: vi.fn() } as any
    );

    (service as any).isBackupInProgress = true;
    await (service as any).performIncrementalSync();

    expect(syncServiceMock.incrementalSync).not.toHaveBeenCalled();
  });

  test('does not mark incremental sync successful when checkpoint fails', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn().mockResolvedValue({
        successfulTables: 1,
        totalTables: 1,
        totalRecords: 10,
      }),
      fullSync: vi.fn(),
    };

    const duckdbMock = {
      checkpoint: vi.fn().mockRejectedValue(new Error('checkpoint failed')),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      duckdbMock as any,
      { query: vi.fn() } as any
    );

    const baselineSyncTime = new Date('2024-01-01T00:00:00.000Z');
    (service as any).lastSuccessfulSync = baselineSyncTime;
    (service as any).restartAttempts = 3;

    const completed = await (service as any).performIncrementalSync();

    expect(completed).toBe(false);
    expect(syncServiceMock.incrementalSync).toHaveBeenCalledTimes(1);
    expect((service as any).lastSuccessfulSync).toBe(baselineSyncTime);
    expect((service as any).restartAttempts).toBe(3);
    expect((service as any).isSyncInProgress).toBe(false);
  });

  test('does not mark full sync successful when checkpoint fails', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn().mockResolvedValue({
        successfulTables: 1,
        totalTables: 1,
        totalRecords: 10,
      }),
    };

    const duckdbMock = {
      checkpoint: vi.fn().mockRejectedValue(new Error('checkpoint failed')),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      duckdbMock as any,
      { query: vi.fn() } as any
    );

    const baselineSyncTime = new Date('2024-01-01T00:00:00.000Z');
    (service as any).lastSuccessfulSync = baselineSyncTime;
    (service as any).restartAttempts = 2;

    await (service as any).performFullSync();

    expect(syncServiceMock.fullSync).toHaveBeenCalledTimes(1);
    expect((service as any).lastSuccessfulSync).toBe(baselineSyncTime);
    expect((service as any).restartAttempts).toBe(2);
    expect((service as any).isSyncInProgress).toBe(false);
  });

  test('attemptRecovery uses guarded incremental sync path', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn(),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      { checkpoint: vi.fn(), query: vi.fn() } as any,
      { query: vi.fn() } as any
    );

    const performIncrementalSyncSpy = vi
      .spyOn(service as any, 'performIncrementalSync')
      .mockResolvedValue(true);
    vi.spyOn(service as any, 'checkDuckDBHealth').mockResolvedValue(true);
    vi.spyOn(service as any, 'checkMySQLHealth').mockResolvedValue(true);

    await (service as any).attemptRecovery();

    expect(performIncrementalSyncSpy).toHaveBeenCalledTimes(1);
    expect(syncServiceMock.incrementalSync).not.toHaveBeenCalled();
  });
});
