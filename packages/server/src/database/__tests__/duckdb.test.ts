import { afterEach, describe, expect, test, vi } from 'vitest';
import DuckDBConnection, { sanitizeLogParams } from '../duckdb';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('DuckDBConnection prepared statement cleanup', () => {
  test('destroys prepared statements after parameterized reads', async () => {
    const prepared = {
      bindVarchar: vi.fn(),
      runAndReadAll: vi.fn(async () => ({
        getRows: () => [['ok']],
        columnNames: () => ['value'],
      })),
    };

    const ctx: any = {
      getPersistentConnection: vi.fn(async () => ({
        prepare: vi.fn(async () => prepared),
      })),
      destroyPreparedStatement: vi.fn(),
      closePersistentConnection: vi.fn(),
      dbInstance: null,
      wasInvalidated: false,
    };

    const executeRaw = (DuckDBConnection.prototype as any).executeRaw.bind(ctx);
    const result = await executeRaw('SELECT ?', ['ok'], false);

    expect(result).toEqual([{ value: 'ok' }]);
    expect(ctx.destroyPreparedStatement).toHaveBeenCalledWith(prepared);
  });

  test('destroys prepared statements after parameterized writes', async () => {
    const prepared = {
      bindVarchar: vi.fn(),
      run: vi.fn(async () => undefined),
    };

    const ctx: any = {
      getPersistentConnection: vi.fn(async () => ({
        prepare: vi.fn(async () => prepared),
      })),
      destroyPreparedStatement: vi.fn(),
      closePersistentConnection: vi.fn(),
      dbInstance: null,
      wasInvalidated: false,
    };

    const runRaw = (DuckDBConnection.prototype as any).runRaw.bind(ctx);
    await runRaw('INSERT INTO t VALUES (?)', ['ok']);

    expect(ctx.destroyPreparedStatement).toHaveBeenCalledWith(prepared);
  });
});

describe('DuckDBConnection.getTables', () => {
  test('excludes internal staging tables from user-visible table lists', async () => {
    const ctx: any = {
      execute: vi.fn(async () => [
        { table_name: 'users' },
        { table_name: '__full_sync_staging_users_deadbeefdeadbeefdeadbeefdeadbeef' },
      ]),
    };

    const getTables = (DuckDBConnection.prototype as any).getTables.bind(ctx);
    const tables = await getTables();

    expect(tables).toEqual(['users']);
  });
});

describe('DuckDBConnection waitForConnection', () => {
  test('retries file lock errors after a short delay', async () => {
    vi.useFakeTimers();

    const connection = Object.create((DuckDBConnection as any).prototype);
    connection.executeRaw = vi.fn()
      .mockRejectedValueOnce(
        new Error('IO Error: Could not set lock on file "/tmp/chitti_common.db": Conflicting lock is held in PID 0')
      )
      .mockResolvedValueOnce([{ ok: 1 }]);

    const waitForConnection = (connection as any).waitForConnection(2, 5000);

    await vi.advanceTimersByTimeAsync(1999);
    expect(connection.executeRaw).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await waitForConnection;

    expect(connection.executeRaw).toHaveBeenCalledTimes(2);
  });
});
