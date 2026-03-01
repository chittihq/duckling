import { describe, expect, test, vi } from 'vitest';
import DuckDBConnection, { sanitizeLogParams } from '../duckdb';

describe('DuckDBConnection getPersistentConnection', () => {
  test('uses a single connect call under concurrent access', async () => {
    const connection = { closeSync: vi.fn() };
    const connect = vi.fn(async () => connection);

    const ctx: any = {
      persistentConn: null,
      persistentConnPromise: null,
      getDbInstance: vi.fn(async () => ({ connect }))
    };

    const getPersistentConnection = (DuckDBConnection.prototype as any).getPersistentConnection.bind(ctx);

    const [conn1, conn2, conn3] = await Promise.all([
      getPersistentConnection(),
      getPersistentConnection(),
      getPersistentConnection()
    ]);

    expect(conn1).toBe(connection);
    expect(conn2).toBe(connection);
    expect(conn3).toBe(connection);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ctx.getDbInstance).toHaveBeenCalledTimes(1);
  });
});

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
