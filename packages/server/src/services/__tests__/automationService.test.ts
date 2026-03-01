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
});
