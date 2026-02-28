import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AutomationService from '../automationService';
import config from '../../config';
import { DatabaseConfigManager } from '../../database/databaseConfig';

describe('AutomationService backup', () => {
  const originalBackupsPath = config.paths.backups;
  const originalMetadataPath = config.paths.metadata;
  const originalDuckdbPath = config.duckdb.path;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-backup-test-'));
    const backupsDir = path.join(tmpDir, 'backups');
    const metadataDir = path.join(tmpDir, 'metadata');
    const duckdbPath = path.join(tmpDir, 'duckling.db');

    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(duckdbPath, 'duckdb-test-data');

    config.paths.backups = backupsDir;
    config.paths.metadata = metadataDir;
    config.duckdb.path = duckdbPath;

    vi.spyOn(DatabaseConfigManager, 'getInstance').mockReturnValue({
      getDatabase: () => ({
        id: 'default',
        name: 'Default Database',
        mysqlConnectionString: 'mysql://test',
        duckdbPath: config.duckdb.path,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        s3: { enabled: false },
      }),
    } as any);
  });

  afterEach(() => {
    config.paths.backups = originalBackupsPath;
    config.paths.metadata = originalMetadataPath;
    config.duckdb.path = originalDuckdbPath;

    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('checkpoints DuckDB before copying backup file', async () => {
    const duckdbMock = {
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };

    const syncServiceMock = {
      incrementalSync: vi.fn(),
      fullSync: vi.fn(),
    };

    const service = new (AutomationService as any)(
      'default',
      syncServiceMock,
      duckdbMock,
      { query: vi.fn() }
    );

    await service.performBackup();

    expect(duckdbMock.checkpoint).toHaveBeenCalledTimes(1);

    const backupDirs = fs.readdirSync(config.paths.backups)
      .filter(name => name.startsWith('backup-'));
    expect(backupDirs.length).toBeGreaterThan(0);

    const duckdbBackupPath = path.join(config.paths.backups, backupDirs[0], 'duckling.db');
    expect(fs.existsSync(duckdbBackupPath)).toBe(true);
  });
});
