import { describe, test, expect } from 'vitest';
import { clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerIncrementalSync } from './helpers/sync.js';
import { getValidation } from './helpers/validation.js';
import { sleep } from './helpers/time.js';

describe('Suite 2: Incremental Insert', () => {
  test('insert new rows and sync', async () => {
    // Sleep to ensure MySQL NOW() timestamps are after the watermark
    await sleep(2000);

    await mysqlExec(`
      INSERT INTO users_with_timestamps (id, name, age, email, bio, balance, is_active, metadata, avatar, birth_date, role, score, created_at, updated_at) VALUES
        (6, 'Frank', 33, 'frank@test.com', 'New hire', 800.00, TRUE, '{"level":1,"tags":["new"]}', NULL, '1991-07-20', 'viewer', 70.0, NOW(), NOW());

      INSERT INTO events_append_only (id, event_type, payload, amount, created_at) VALUES
        (4, 'logout', '{"reason":"timeout"}', 0.0000, NOW());

      INSERT INTO products_simple (id, name, price, quantity, updated_at) VALUES
        (5, 'Widget E', 14.99, 200, NOW());
    `);

    await triggerIncrementalSync();
  });

  test('counts increased by 1', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt')).toBe('6');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt')).toBe('4');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt')).toBe('5');
  });

  test('Frank exists in ClickHouse', async () => {
    expect(await clickhouseScalarStrict('SELECT name FROM users_with_timestamps WHERE id = 6', 'name')).toBe('Frank');
  });

  test('Frank JSON metadata', async () => {
    const raw = await clickhouseScalarStrict('SELECT metadata FROM users_with_timestamps WHERE id = 6', 'metadata');
    const parsed = JSON.parse(raw);
    expect(parsed.level).toBe(1);
    expect(parsed.tags).toEqual(['new']);
  });

  test('Frank is_active (BOOLEAN)', async () => {
    const val = await clickhouseScalarStrict('SELECT is_active FROM users_with_timestamps WHERE id = 6', 'is_active');
    expect(val === 'true' || val === '1').toBe(true);
  });

  test('Frank birth_date (DATE)', async () => {
    const val = await clickhouseScalarStrict(
      'SELECT CAST(birth_date AS VARCHAR) AS bd FROM users_with_timestamps WHERE id = 6',
      'bd',
    );
    expect(val).toBe('1991-07-20');
  });

  test('Frank role (ENUM)', async () => {
    expect(await clickhouseScalarStrict('SELECT role FROM users_with_timestamps WHERE id = 6', 'role')).toBe('viewer');
  });

  test('Logout event exists in ClickHouse', async () => {
    expect(await clickhouseScalarStrict('SELECT event_type FROM events_append_only WHERE id = 4', 'event_type')).toBe('logout');
  });

  test('Widget E exists in ClickHouse', async () => {
    expect(await clickhouseScalarStrict('SELECT name FROM products_simple WHERE id = 5', 'name')).toBe('Widget E');
  });

  test('users validation: max ID after insert', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.clickhouse.maxId).toBe(val.mysql.maxId);
  });

  test('users validation: checksum after insert', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.clickhouse.checksum).toBe(val.mysql.checksum);
  });
});
