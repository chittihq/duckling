import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('fs', () => {
  return {
    existsSync: vi.fn((filePath: string) => filePath === '/app/data/tenant.db'),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import AutomationService from '../automationService';
import { DatabaseConfigManager } from '../../database/databaseConfig';
import * as fs from 'fs';

describe('AutomationService backups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AutomationService.closeInstance('tenant-db');
  });

  test('performBackup uses database-specific duckdbPath for local backup', async () => {
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => ({
        id: 'tenant-db',
        duckdbPath: 'data/tenant.db',
      }),
    } as any);

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      '/app/data/tenant.db',
      expect.stringMatching(/duckling\.db$/)
    );
  });
});
