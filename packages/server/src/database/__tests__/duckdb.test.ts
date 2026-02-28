import { describe, test, expect, vi } from 'vitest';
import DuckDBConnection from '../duckdb';

describe('DuckDBConnection getPersistentConnection', () => {
  test('uses a single connect call under concurrent access', async () => {
    const connection = { closeSync: vi.fn() };
    const connect = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return connection;
    });

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
