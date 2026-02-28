import { afterEach, describe, expect, test, vi } from 'vitest';

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
import { DatabaseConfigManager } from '../../database/databaseConfig';
import config from '../../config';
import * as fs from 'fs';

describe('AutomationService backups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AutomationService.closeInstance('tenant-db');
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

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      '/app/data/tenant.db',
      expect.stringMatching(/duckling\.db$/)
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

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith('/custom/tenant.db', expect.stringMatching(/duckling\.db$/));
  });

  test('performBackup falls back to global duckdb path when database config is missing', async () => {
    const fallbackPath = config.duckdb.path.startsWith('data/') ? `/app/${config.duckdb.path}` : config.duckdb.path;
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === fallbackPath);
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => undefined,
    } as any);

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith(fallbackPath, expect.stringMatching(/duckling\.db$/));
  });
});
