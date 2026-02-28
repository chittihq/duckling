import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import DuckDBConnection from '../duckdb';

describe('DuckDBConnection blob parameter binding', () => {
  const databaseId = `blob-binding-${Date.now()}`;
  const dbPath = path.join(os.tmpdir(), `${databaseId}.db`);

  afterEach(async () => {
    DuckDBConnection.closeInstance(databaseId);
    [dbPath, `${dbPath}.wal`].forEach(filePath => {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  });

  test('binds blob values in run() and execute()', async () => {
    const db = DuckDBConnection.getInstance(databaseId, dbPath);
    const blob = Buffer.from([1, 2, 3, 4]);

    await db.run('CREATE TABLE blob_binding_test (id INTEGER, data BLOB)');
    await db.run('INSERT INTO blob_binding_test (id, data) VALUES (?, ?)', [1, blob]);

    const rows = await db.execute('SELECT id FROM blob_binding_test WHERE data = ?', [blob]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });
});
