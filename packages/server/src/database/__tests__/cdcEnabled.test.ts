import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Continuous replication is a per-database setting, persisted in
 * databases.json. Before this, CDC could only be started through the API and
 * the choice was lost on every restart — so a redeploy silently dropped a
 * database back to periodic-sync-only without telling anyone.
 */

let tmpDir: string;

async function freshManager(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.DATA_PATH = tmpDir;
  const mod = await import('../databaseConfig');
  // Singleton is per-module-instance; resetModules above gives a fresh one.
  return mod.DatabaseConfigManager.getInstance();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-cdc-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CDC_AUTO_START;
  delete process.env.DATA_PATH;
  delete process.env.MYSQL_CONNECTION_STRING;
});

describe('per-database cdcEnabled', () => {
  test('defaults to off, so adding a database never silently starts replication', async () => {
    const mgr = await freshManager({ CDC_AUTO_START: undefined });
    const db = mgr.addDatabase({
      name: 'lms',
      mysqlConnectionString: 'mysql://u:p@h:3306/lms',
    } as any);

    expect(db.cdcEnabled).toBe(false);
  });

  test('CDC_AUTO_START supplies the default for newly added databases only', async () => {
    const mgr = await freshManager({ CDC_AUTO_START: 'true' });
    const db = mgr.addDatabase({
      name: 'lms',
      mysqlConnectionString: 'mysql://u:p@h:3306/lms',
    } as any);

    expect(db.cdcEnabled).toBe(true);
  });

  test('an explicit per-database value wins over the environment default', async () => {
    const mgr = await freshManager({ CDC_AUTO_START: 'true' });
    const db = mgr.addDatabase({
      name: 'lms',
      mysqlConnectionString: 'mysql://u:p@h:3306/lms',
      cdcEnabled: false,
    } as any);

    expect(db.cdcEnabled).toBe(false);
  });

  test('the setting survives a restart (this is the whole point)', async () => {
    const mgr = await freshManager();
    const db = mgr.addDatabase({
      name: 'lms',
      mysqlConnectionString: 'mysql://u:p@h:3306/lms',
    } as any);
    mgr.updateDatabase(db.id, { cdcEnabled: true });

    // Simulate a process restart: brand new manager reading the same file.
    const restarted = await freshManager();
    expect(restarted.getDatabase(db.id)?.cdcEnabled).toBe(true);

    // ...and disabling persists too, so a restart cannot resurrect
    // replication an operator deliberately stopped.
    restarted.updateDatabase(db.id, { cdcEnabled: false });
    const again = await freshManager();
    expect(again.getDatabase(db.id)?.cdcEnabled).toBe(false);
  });

  test('databases are independent — one enabled does not enable another', async () => {
    const mgr = await freshManager();
    const a = mgr.addDatabase({ name: 'lms', mysqlConnectionString: 'mysql://u:p@h:3306/a' } as any);
    const b = mgr.addDatabase({ name: 'common', mysqlConnectionString: 'mysql://u:p@h:3306/b' } as any);

    mgr.updateDatabase(a.id, { cdcEnabled: true });

    const restarted = await freshManager();
    expect(restarted.getDatabase(a.id)?.cdcEnabled).toBe(true);
    expect(restarted.getDatabase(b.id)?.cdcEnabled).toBe(false);
  });
});
