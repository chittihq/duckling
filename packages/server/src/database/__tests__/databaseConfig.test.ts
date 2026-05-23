import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../../config', () => ({
  __esModule: true,
  default: {
    paths: {
      data: '/tmp/duckling-config-test',
    },
    clickhouse: {
      database: 'default',
    },
  },
}));

import { DatabaseConfigManager } from '../databaseConfig';

const CONFIG_FILE = '/tmp/duckling-config-test/databases.json';
const TEMP_FILE = `${CONFIG_FILE}.tmp`;

describe('DatabaseConfigManager safety', () => {
  beforeEach(() => {
    (DatabaseConfigManager as any).instance = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    (DatabaseConfigManager as any).instance = undefined;
    vi.restoreAllMocks();
  });

  test('writes configs atomically via temp file + rename', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    DatabaseConfigManager.getInstance();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      TEMP_FILE,
      expect.stringContaining('"id": "default"')
    );
    expect(fs.renameSync).toHaveBeenCalledWith(TEMP_FILE, CONFIG_FILE);
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.anything()
    );
  });

  test('deletes temp file if atomic rename fails', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('rename failed');
    });

    expect(() => DatabaseConfigManager.getInstance()).toThrow('rename failed');
    expect(fs.unlinkSync).toHaveBeenCalledWith(TEMP_FILE);
  });

  test('backs up corrupted config and throws instead of silently resetting', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue('{"invalid_json"');

    expect(() => DatabaseConfigManager.getInstance()).toThrow(/Database config is corrupted/);
    expect(fs.renameSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringMatching(/^\/tmp\/duckling-config-test\/databases\.json\.corrupted\./)
    );
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('still throws corruption error when backup rename itself fails', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue('{"invalid_json"');
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => DatabaseConfigManager.getInstance()).toThrow(/Database config is corrupted/);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('I/O read error throws without backing up or overwriting the config file', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => filePath === CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(() => DatabaseConfigManager.getInstance()).toThrow(/Cannot read database config/);
    // Must NOT rename the (potentially valid) config file
    expect(fs.renameSync).not.toHaveBeenCalled();
    // Must NOT overwrite with a default config
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
