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

describe('DatabaseConfigManager per-database API keys', () => {
  // Seed two databases so cross-database lookups can be exercised.
  const seed = JSON.stringify([
    { id: 'alpha', name: 'Alpha', mysqlConnectionString: '', clickhouseDatabase: 'alpha', createdAt: 'x', updatedAt: 'x' },
    { id: 'beta', name: 'Beta', mysqlConnectionString: '', clickhouseDatabase: 'beta', createdAt: 'x', updatedAt: 'x' },
  ]);

  let mgr: DatabaseConfigManager;

  beforeEach(() => {
    (DatabaseConfigManager as any).instance = undefined;
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => p === CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue(seed);
    mgr = DatabaseConfigManager.getInstance();
  });

  afterEach(() => {
    (DatabaseConfigManager as any).instance = undefined;
    vi.restoreAllMocks();
  });

  test('created key resolves to its database; secret shown once, hash never returned', () => {
    const created = mgr.createApiKey('alpha', { name: 'CI token' });
    expect(created).not.toBeNull();
    expect(created!.secret).toMatch(/^dk_/);

    const match = mgr.lookupApiKey(created!.secret);
    expect(match).not.toBeNull();
    expect(match!.databaseId).toBe('alpha');
    expect(match!.keyId).toBe(created!.record.id);

    // listApiKeys exposes metadata but never the hash.
    const listed = mgr.listApiKeys('alpha')!;
    expect(listed).toHaveLength(1);
    expect((listed[0] as any).hash).toBeUndefined();
    expect(listed[0].last4).toBe(created!.secret.slice(-4));
  });

  test('unknown / malformed tokens return null', () => {
    expect(mgr.lookupApiKey('dk_does-not-exist')).toBeNull();
    expect(mgr.lookupApiKey('')).toBeNull();
  });

  test('a key for one database never resolves to another', () => {
    const a = mgr.createApiKey('alpha', { name: 'a' })!;
    const b = mgr.createApiKey('beta', { name: 'b' })!;
    expect(mgr.lookupApiKey(a.secret)!.databaseId).toBe('alpha');
    expect(mgr.lookupApiKey(b.secret)!.databaseId).toBe('beta');
  });

  test('disabled key stops resolving and re-enabling restores it', () => {
    const k = mgr.createApiKey('alpha', { name: 'toggle' })!;
    mgr.updateApiKey('alpha', k.record.id, { enabled: false });
    expect(mgr.lookupApiKey(k.secret)).toBeNull();
    mgr.updateApiKey('alpha', k.record.id, { enabled: true });
    expect(mgr.lookupApiKey(k.secret)).not.toBeNull();
  });

  test('expired key does not resolve', () => {
    const k = mgr.createApiKey('alpha', { name: 'exp', expiresAt: '2000-01-01T00:00:00.000Z' })!;
    expect(mgr.lookupApiKey(k.secret)).toBeNull();
  });

  test('revoked key stops resolving', () => {
    const k = mgr.createApiKey('alpha', { name: 'revoke' })!;
    expect(mgr.deleteApiKey('alpha', k.record.id)).toBe(true);
    expect(mgr.lookupApiKey(k.secret)).toBeNull();
    expect(mgr.deleteApiKey('alpha', k.record.id)).toBe(false);
  });

  test('lookup updates lastUsedAt in memory', () => {
    const k = mgr.createApiKey('alpha', { name: 'touch' })!;
    expect(mgr.listApiKeys('alpha')![0].lastUsedAt).toBeUndefined();
    mgr.lookupApiKey(k.secret);
    expect(mgr.listApiKeys('alpha')![0].lastUsedAt).toBeDefined();
  });

  test('createApiKey on an unknown database returns null', () => {
    expect(mgr.createApiKey('ghost', { name: 'x' })).toBeNull();
  });
});
