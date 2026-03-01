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

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
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

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
    await (service as any).performBackup();

    expect(fs.copyFileSync).toHaveBeenCalledWith('/custom/tenant.db', expect.stringMatching(/backup-tenant-db-.*\/duckling-tenant-db\.db$/));
  });

  test('performBackup falls back to global duckdb path when database config is missing', async () => {
    const fallbackPath = config.duckdb.path.startsWith('data/') ? `/app/${config.duckdb.path}` : config.duckdb.path;
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === fallbackPath);
    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => undefined,
    } as any);

    const service = AutomationService.getInstance('tenant-db', {} as any, {} as any, {} as any);
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

    const serviceA = AutomationService.getInstance('tenant-db-a', {} as any, {} as any, {} as any);
    const serviceB = AutomationService.getInstance('tenant-db-b', {} as any, {} as any, {} as any);

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
