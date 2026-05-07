import { describe, test, expect } from 'vitest';
import { clickhouseQuery, clickhouseScalarStrict, normalizeDecimal } from './helpers/clickhouse.js';
import { triggerFullSync } from './helpers/sync.js';
import { getValidation } from './helpers/validation.js';

describe('Suite 1: Full Sync', () => {
  test('trigger full sync', async () => {
    const result = await triggerFullSync();
    const successfulTables = result?.successfulTables ?? result?.totalTables ?? '';
    expect(String(successfulTables)).not.toBe('');
  });

  test('record counts match seed data', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt')).toBe('5');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt')).toBe('3');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt')).toBe('4');
  });

  test('Alice name in DuckDB', async () => {
    expect(await clickhouseScalarStrict('SELECT name FROM users_with_timestamps WHERE id = 1', 'name')).toBe('Alice');
  });

  test('Alice age (TINYINT)', async () => {
    expect(await clickhouseScalarStrict('SELECT age FROM users_with_timestamps WHERE id = 1', 'age')).toBe('30');
  });

  test('Alice balance (DECIMAL)', async () => {
    const raw = await clickhouseScalarStrict('SELECT balance FROM users_with_timestamps WHERE id = 1', 'balance');
    expect(normalizeDecimal(raw)).toBe('1500.5');
  });

  test('Alice balance via CAST (cross-check)', async () => {
    const raw = await clickhouseScalarStrict(
      'SELECT CAST(balance AS DOUBLE) AS bal FROM users_with_timestamps WHERE id = 1',
      'bal',
    );
    expect(normalizeDecimal(raw)).toBe('1500.5');
  });

  test('Alice role (ENUM)', async () => {
    expect(await clickhouseScalarStrict('SELECT role FROM users_with_timestamps WHERE id = 1', 'role')).toBe('admin');
  });

  test('Alice is_active (BOOLEAN)', async () => {
    const val = await clickhouseScalarStrict('SELECT is_active FROM users_with_timestamps WHERE id = 1', 'is_active');
    expect(val === 'true' || val === '1').toBe(true);
  });

  test('Alice JSON metadata.level', async () => {
    const raw = await clickhouseScalarStrict('SELECT metadata FROM users_with_timestamps WHERE id = 1', 'metadata');
    const parsed = JSON.parse(raw);
    expect(String(parsed.level)).toBe('5');
  });

  test('Diana bio is NULL', async () => {
    const data = await clickhouseQuery('SELECT bio FROM users_with_timestamps WHERE id = 4');
    expect(data.result[0].bio).toBeNull();
  });

  test('Alice score (FLOAT)', async () => {
    const raw = await clickhouseScalarStrict('SELECT score FROM users_with_timestamps WHERE id = 1', 'score');
    expect(normalizeDecimal(raw)).toBe('92.5');
  });

  test('Alice birth_date (DATE)', async () => {
    let val = await clickhouseScalarStrict(
      'SELECT CAST(birth_date AS VARCHAR) AS bd FROM users_with_timestamps WHERE id = 1',
      'bd',
    );
    expect(val).toBe('1994-06-15');
  });

  test('Event BIGINT id', async () => {
    expect(
      await clickhouseScalarStrict("SELECT id FROM events_append_only WHERE event_type = 'purchase'", 'id'),
    ).toBe('2');
  });

  test('Event amount DECIMAL(10,4)', async () => {
    const raw = await clickhouseScalarStrict('SELECT amount FROM events_append_only WHERE id = 2', 'amount');
    expect(normalizeDecimal(raw)).toBe('149.99');
  });

  test('Event amount via CAST (cross-check)', async () => {
    const raw = await clickhouseScalarStrict(
      'SELECT CAST(amount AS DOUBLE) AS amt FROM events_append_only WHERE id = 2',
      'amt',
    );
    expect(normalizeDecimal(raw)).toBe('149.99');
  });

  test('users validation: max ID match', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.duckdb.maxId).toBe(val.mysql.maxId);
  });

  test('users validation: checksum match', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.duckdb.checksum).toBe(val.mysql.checksum);
  });

  test('users validation: columns match', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(String(val.columnsMatch)).toBe('true');
  });

  test('users validation: no error', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.errorType ?? 'null').toBe('null');
  });

  test('products validation: max ID match', async () => {
    const val = await getValidation('products_simple');
    expect(val.duckdb.maxId).toBe(val.mysql.maxId);
  });

  test('products validation: checksum match', async () => {
    const val = await getValidation('products_simple');
    expect(val.duckdb.checksum).toBe(val.mysql.checksum);
  });

  test('events validation: max ID match', async () => {
    const val = await getValidation('events_append_only');
    expect(val.duckdb.maxId).toBe(val.mysql.maxId);
  });
});
