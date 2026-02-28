import { describe, expect, test } from 'vitest';
import { sanitizeLogParams } from '../duckdb';

describe('sanitizeLogParams', () => {
  test('replaces Buffer and Uint8Array values with safe placeholders', () => {
    const params = [Buffer.from('secret'), new Uint8Array([1, 2, 3]), 'ok', 42, null];

    expect(sanitizeLogParams(params)).toEqual([
      '<Buffer length=6>',
      '<Uint8Array length=3>',
      'ok',
      42,
      null
    ]);
  });

  test('returns undefined when params are undefined', () => {
    expect(sanitizeLogParams(undefined)).toBeUndefined();
  });
});
