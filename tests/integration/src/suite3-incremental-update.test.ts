import { describe, test, expect } from 'vitest';
import { clickhouseScalarStrict, normalizeDecimal } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerIncrementalSync, triggerFullSync } from './helpers/sync.js';
import { getValidation } from './helpers/validation.js';
import { sleep } from './helpers/time.js';

describe('Suite 3: Incremental Update', () => {
  test('update rows and trigger incremental sync', async () => {
    // Sleep to ensure MySQL NOW() timestamps are clearly after the watermark
    await sleep(3000);

    await mysqlExec(`
      UPDATE users_with_timestamps SET balance = 2000.75, role = 'editor', updated_at = NOW() WHERE id = 1;
      UPDATE products_simple SET price = 34.99, quantity = 80, updated_at = NOW() WHERE id = 1;
    `);

    await triggerIncrementalSync();
  });

  test('products count unchanged after update', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt')).toBe('5');
  });

  test('Widget A price updated (incremental)', async () => {
    const raw = await clickhouseScalarStrict(
      'SELECT CAST(price AS DOUBLE) AS price FROM products_simple WHERE id = 1',
      'price',
    );
    expect(normalizeDecimal(raw)).toBe('34.99');
  });

  test('Widget A quantity updated (incremental)', async () => {
    expect(await clickhouseScalarStrict('SELECT quantity FROM products_simple WHERE id = 1', 'quantity')).toBe('80');
  });

  test('products checksum after update', async () => {
    const val = await getValidation('products_simple');
    expect(val.clickhouse.checksum).toBe(val.mysql.checksum);
  });

  test('run full sync for users_with_timestamps (BLOB workaround)', async () => {
    await triggerFullSync();
  });

  test('users count unchanged after update', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt')).toBe('6');
  });

  test('Alice balance updated (full sync)', async () => {
    const raw = await clickhouseScalarStrict(
      'SELECT CAST(balance AS DOUBLE) AS balance FROM users_with_timestamps WHERE id = 1',
      'balance',
    );
    expect(normalizeDecimal(raw)).toBe('2000.75');
  });

  test('Alice role updated (full sync)', async () => {
    expect(await clickhouseScalarStrict('SELECT role FROM users_with_timestamps WHERE id = 1', 'role')).toBe('editor');
  });

  test('users checksum after update', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.clickhouse.checksum).toBe(val.mysql.checksum);
  });
});
