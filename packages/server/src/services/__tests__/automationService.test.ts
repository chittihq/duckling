import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('fs', () => {
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import AutomationService from '../automationService';
import { SyncAlreadyInProgressError } from '../sequentialAppenderService';
import { DatabaseConfigManager } from '../../database/databaseConfig';
import config from '../../config';
import * as fs from 'fs';

describe('AutomationService backups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AutomationService.closeInstance('tenant-db');
    AutomationService.closeInstance('tenant-db-a');
    AutomationService.closeInstance('tenant-db-b');
  });

  test('performBackup uses database-specific duckdbPath for local backup', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === '/app/data/tenant.db');
    const getDatabase = vi.fn(() => ({
      id: 'tenant-db',
      duckdbPath: 'data/tenant.db',
    }));
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase,
    } as any);

    const duckdbMock = { checkpoint: vi.fn().mockResolvedValue(undefined) };
    const service = AutomationService.getInstance('tenant-db', {} as any, duckdbMock as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      '/app/data/tenant.db',
      expect.stringMatching(/backup-tenant-db-.*\/duckling-tenant-db\.db$/)
    );
    expect(getDatabase).toHaveBeenCalledWith('tenant-db');
  });

  test('performBackup keeps absolute duckdbPath unchanged', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === '/custom/tenant.db');
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => ({
        id: 'tenant-db',
        duckdbPath: '/custom/tenant.db',
      }),
    } as any);

    const duckdbMock = { checkpoint: vi.fn().mockResolvedValue(undefined) };
    const service = AutomationService.getInstance('tenant-db', {} as any, duckdbMock as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith('/custom/tenant.db', expect.stringMatching(/backup-tenant-db-.*\/duckling-tenant-db\.db$/));
  });

  test('performBackup falls back to global duckdb path when database config is missing', async () => {
    const fallbackPath = config.duckdb.path.startsWith('data/') ? `/app/${config.duckdb.path}` : config.duckdb.path;
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === fallbackPath);
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => undefined,
    } as any);

    const duckdbMock = { checkpoint: vi.fn().mockResolvedValue(undefined) };
    const service = AutomationService.getInstance('tenant-db', {} as any, duckdbMock as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(fallbackPath, expect.stringMatching(/backup-tenant-db-.*\/duckling-tenant-db\.db$/));
  });

  test('performBackup writes distinct local backup targets for different database IDs', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) =>
      filePath === '/app/data/tenant-a.db' || filePath === '/app/data/tenant-b.db'
    );
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: (id: string) => {
        if (id === 'tenant-db-a') {
          return { id, duckdbPath: 'data/tenant-a.db' };
        }
        if (id === 'tenant-db-b') {
          return { id, duckdbPath: 'data/tenant-b.db' };
        }
        return undefined;
      },
    } as any);

    const duckdbMock = { checkpoint: vi.fn().mockResolvedValue(undefined) };
    const serviceA = AutomationService.getInstance('tenant-db-a', {} as any, duckdbMock as any, {} as any);
    const serviceB = AutomationService.getInstance('tenant-db-b', {} as any, duckdbMock as any, {} as any);

    await (serviceA as any).performBackup();
    await (serviceB as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      '/app/data/tenant-a.db',
      expect.stringMatching(/backup-tenant-db-a-.*\/duckling-tenant-db-a\.db$/)
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      '/app/data/tenant-b.db',
      expect.stringMatching(/backup-tenant-db-b-.*\/duckling-tenant-db-b\.db$/)
    );
  });

  test('cleanupOldBackups only deletes backups for the current database prefix', async () => {
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => ({
        id: 'tenant-db',
        duckdbPath: 'data/tenant.db',
      }),
    } as any);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'backup-tenant-db-2024-01-01T00-00-00-000Z',
      'backup-tenant-db-b-2024-01-01T00-00-00-000Z',
      'backup-default-2024-01-01T00-00-00-000Z',
    ] as any);
    vi.mocked(fs.statSync).mockImplementation(() => ({
      isDirectory: () => true,
      mtime: new Date('2000-01-01T00:00:00.000Z'),
    } as any));

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).cleanupOldBackups('/tmp/backups');

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync).toHaveBeenCalledWith(
      '/tmp/backups/backup-tenant-db-2024-01-01T00-00-00-000Z',
      { recursive: true, force: true }
    );
  });
});

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
    const result = await (service as any).performIncrementalSync();

    expect(result).toBe('skipped');
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

    const result = await (service as any).performFullSync();

    expect(result).toBe(false);
    expect(syncServiceMock.fullSync).toHaveBeenCalledTimes(1);
    expect((service as any).lastSuccessfulSync).toBe(baselineSyncTime);
    expect((service as any).restartAttempts).toBe(2);
    expect((service as any).isSyncInProgress).toBe(false);
  });

  test('attemptRecovery does not burn restart attempts when sync is skipped', async () => {
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

    vi.spyOn(service as any, 'performIncrementalSync').mockResolvedValue('skipped');
    vi.spyOn(service as any, 'checkDuckDBHealth').mockResolvedValue(true);
    vi.spyOn(service as any, 'checkMySQLHealth').mockResolvedValue(true);

    (service as any).restartAttempts = 0;
    await (service as any).attemptRecovery();

    // restartAttempts incremented to 1 then decremented back to 0 on skip
    expect((service as any).restartAttempts).toBe(0);
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
      .mockResolvedValue('completed');
    vi.spyOn(service as any, 'checkDuckDBHealth').mockResolvedValue(true);
    vi.spyOn(service as any, 'checkMySQLHealth').mockResolvedValue(true);

    await (service as any).attemptRecovery();

    expect(performIncrementalSyncSpy).toHaveBeenCalledTimes(1);
    expect(syncServiceMock.incrementalSync).not.toHaveBeenCalled();
  });

  test('performHealthCheck skips recovery while sync is in progress', async () => {
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

    (service as any).isSyncInProgress = true;
    const checkDuckDBHealthSpy = vi.spyOn(service as any, 'checkDuckDBHealth');
    const checkMySQLHealthSpy = vi.spyOn(service as any, 'checkMySQLHealth');
    const attemptRecoverySpy = vi.spyOn(service as any, 'attemptRecovery');

    await (service as any).performHealthCheck();

    expect(checkDuckDBHealthSpy).not.toHaveBeenCalled();
    expect(checkMySQLHealthSpy).not.toHaveBeenCalled();
    expect(attemptRecoverySpy).not.toHaveBeenCalled();
  });

  test('attemptRecovery exits early while backup is in progress', async () => {
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

    (service as any).isBackupInProgress = true;
    const performIncrementalSyncSpy = vi.spyOn(service as any, 'performIncrementalSync');
    const checkDuckDBHealthSpy = vi.spyOn(service as any, 'checkDuckDBHealth');
    const checkMySQLHealthSpy = vi.spyOn(service as any, 'checkMySQLHealth');

    await (service as any).attemptRecovery();

    expect(checkDuckDBHealthSpy).not.toHaveBeenCalled();
    expect(checkMySQLHealthSpy).not.toHaveBeenCalled();
    expect(performIncrementalSyncSpy).not.toHaveBeenCalled();
    expect((service as any).restartAttempts).toBe(0);
  });

  test('performFullSyncWithStats returns stats on success and clears in-progress flag', async () => {
    const syncStats = {
      successfulTables: 2,
      totalTables: 2,
      totalRecords: 25,
      failedTables: 0,
      totalDuration: 42,
      errors: [],
      syncDetails: {
        sequential: 2,
        watermark: 0,
      },
    };

    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn().mockResolvedValue(syncStats),
    };

    const duckdbMock = {
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      duckdbMock as any,
      { query: vi.fn() } as any
    );

    const result = await (service as any).performFullSyncWithStats();

    expect(result).toEqual({ status: 'completed', stats: syncStats });
    expect(duckdbMock.checkpoint).toHaveBeenCalledTimes(1);
    expect((service as any).isSyncInProgress).toBe(false);
  });

  test('performIncrementalSyncWithStats returns skip reason while backup is in progress', async () => {
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
    const result = await (service as any).performIncrementalSyncWithStats();

    expect(result).toEqual({
      status: 'skipped',
      reason: 'backup is currently in progress',
    });
    expect(syncServiceMock.incrementalSync).not.toHaveBeenCalled();
  });

  test('performIncrementalSyncWithStats maps sync lock contention to skipped', async () => {
    const syncServiceMock = {
      incrementalSync: vi.fn().mockRejectedValue(
        new SyncAlreadyInProgressError()
      ),
      fullSync: vi.fn(),
    };

    const service = AutomationService.getInstance(
      databaseId,
      syncServiceMock as any,
      { checkpoint: vi.fn() } as any,
      { query: vi.fn() } as any
    );

    const result = await (service as any).performIncrementalSyncWithStats();

    expect(result).toEqual({
      status: 'skipped',
      reason: 'another sync is already in progress',
    });
    expect((service as any).isSyncInProgress).toBe(false);
  });
});
