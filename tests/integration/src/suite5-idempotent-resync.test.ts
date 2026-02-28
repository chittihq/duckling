import { describe, test, expect } from 'vitest';
import { duckdbScalarStrict } from './helpers/duckdb.js';
import { triggerFullSync } from './helpers/sync.js';
import { getValidation } from './helpers/validation.js';

describe('Suite 5: Idempotent Re-sync', () => {
  let usersBefore: string;
  let eventsBefore: string;
  let productsBefore: string;

  test('record baselines and re-sync', async () => {
    usersBefore = await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt');
    eventsBefore = await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt');
    productsBefore = await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt');

    await triggerFullSync();
  });

  test('users no duplicates after re-sync', async () => {
    expect(await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt')).toBe(usersBefore);
  });

  test('events no duplicates after re-sync', async () => {
    expect(await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt')).toBe(eventsBefore);
  });

  test('products no duplicates after re-sync', async () => {
    expect(await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt')).toBe(productsBefore);
  });

  test('users checksum after re-sync', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.duckdb.checksum).toBe(val.mysql.checksum);
  });

  test('products checksum after re-sync', async () => {
    const val = await getValidation('products_simple');
    expect(val.duckdb.checksum).toBe(val.mysql.checksum);
  });

  test('users no error after re-sync', async () => {
    const val = await getValidation('users_with_timestamps');
    expect(val.errorType ?? 'null').toBe('null');
  });

  test('events no error after re-sync', async () => {
    const val = await getValidation('events_append_only');
    expect(val.errorType ?? 'null').toBe('null');
  });

  test('products no error after re-sync', async () => {
    const val = await getValidation('products_simple');
    expect(val.errorType ?? 'null').toBe('null');
  });
});
