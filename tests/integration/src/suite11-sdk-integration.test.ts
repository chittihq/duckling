import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import type { DuckDBSDKConfig } from '@chittihq/duckling';
import { DuckDBError, DuckDBErrorType, DucklingClient } from '@chittihq/duckling';

import { API_KEY, DB_ID, WS_URL } from './helpers/config.js';
import { triggerFullSync } from './helpers/sync.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Suite 11: SDK Integration', () => {
  const clients: DucklingClient[] = [];

  type ClientOverrides = Partial<DuckDBSDKConfig>;

  function createClient(overrides: ClientOverrides = {}): DucklingClient {
    const client = new DucklingClient({
      url: WS_URL,
      apiKey: API_KEY,
      databaseName: DB_ID,
      autoReconnect: false,
      autoPing: false,
      connectionTimeout: 5000,
      requestTimeout: 5000,
      ...overrides,
    });

    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    await triggerFullSync();
  });

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  test('explicit connect, query, stats, and close work against the live server', async () => {
    const client = createClient();

    await client.connect();
    const rows = await client.query<{ name: string }>(
      'SELECT name FROM users_with_timestamps WHERE id = ?',
      [1],
    );

    expect(rows).toEqual([{ name: 'Alice' }]);
    expect(client.isConnected()).toBe(true);
    expect(client.getStats()).toMatchObject({
      connected: true,
      authenticated: true,
      pendingRequests: 0,
      reconnectAttempts: 0,
      url: WS_URL,
    });

    client.close();
    expect(client.isConnected()).toBe(false);
  });

  test('auto-connect, ping, batch APIs, and pagination work against the live server', async () => {
    const client = createClient();

    const counts = await client.query<{ count: number }>('SELECT COUNT(*) AS count FROM users_with_timestamps');
    expect(Number(counts[0].count)).toBe(5);

    expect(await client.ping()).toBe(true);

    const batch = await client.queryBatch<{ count: number }>([
      'SELECT COUNT(*) AS count FROM users_with_timestamps',
      'SELECT COUNT(*) AS count FROM events_append_only',
    ]);
    expect(Number(batch[0][0].count)).toBe(5);
    expect(Number(batch[1][0].count)).toBe(3);

    const detailed = await client.queryBatchDetailed<{ id: number }>([
      { sql: 'SELECT id FROM users_with_timestamps ORDER BY id LIMIT 2' },
      { sql: 'SELECT * FROM definitely_missing_table' },
    ]);
    expect(detailed[0].success).toBe(true);
    expect(detailed[0].data?.map((row) => Number(row.id))).toEqual([1, 2]);
    expect(detailed[1].success).toBe(false);
    expect(detailed[1].error).toMatch(/Query failed:/);

    const paginated = await client.queryPaginated<{ id: number }>(
      'SELECT id FROM users_with_timestamps ORDER BY id',
      { limit: 2, offset: 1 },
    );
    expect(paginated.data.map((row) => Number(row.id))).toEqual([2, 3]);
    expect(paginated.pagination).toEqual({
      offset: 1,
      limit: 2,
      hasMore: true,
    });
  });

  test('connected, disconnected, and message events are emitted on real traffic', async () => {
    const lifecycleEvents: string[] = [];
    const messageIds: string[] = [];
    const client = createClient();

    client.on('connected', () => {
      lifecycleEvents.push('connected');
    });
    client.on('disconnected', () => {
      lifecycleEvents.push('disconnected');
    });
    client.on('message', (message) => {
      messageIds.push(message.id);
    });

    await client.connect();
    await client.query('SELECT 1 AS value');
    client.close();

    expect(lifecycleEvents).toContain('connected');
    expect(lifecycleEvents).toContain('disconnected');
    expect(messageIds).toContain('welcome');
    expect(messageIds.length).toBeGreaterThanOrEqual(3);
  });

  test('query failures surface as typed DuckDBError instances', async () => {
    const client = createClient();

    await expect(client.query('SELECT * FROM does_not_exist')).rejects.toMatchObject({
      name: 'DuckDBError',
      type: DuckDBErrorType.QUERY_ERROR,
    });
  });

  test('invalid API key fails authentication without reconnecting on close code 1008', async () => {
    const reconnectAttempts: number[] = [];
    const exhaustedEvents: Array<{ attempts: number; error: Error }> = [];
    const client = createClient({
      apiKey: 'definitely-wrong',
      autoReconnect: true,
      reconnectDelay: 50,
      maxReconnectAttempts: 2,
    });

    client.on('reconnecting', (attempt) => {
      reconnectAttempts.push(attempt);
    });
    client.on('reconnectExhausted', (attempts, error) => {
      exhaustedEvents.push({ attempts, error });
    });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'DuckDBError',
      type: DuckDBErrorType.AUTH_ERROR,
    });

    await delay(150);
    expect(reconnectAttempts).toEqual([]);
    expect(exhaustedEvents).toEqual([]);
    expect(client.isConnected()).toBe(false);
  });

  test('invalid database closes with 1011 and does not trigger reconnect attempts', async () => {
    const reconnectAttempts: number[] = [];
    const exhaustedEvents: number[] = [];
    const client = createClient({
      databaseName: 'definitely-missing-db',
      autoReconnect: true,
      reconnectDelay: 50,
      maxReconnectAttempts: 2,
    });

    client.on('reconnecting', (attempt) => {
      reconnectAttempts.push(attempt);
    });
    client.on('reconnectExhausted', (attempts) => {
      exhaustedEvents.push(attempts);
    });

    await expect(client.connect()).rejects.toBeInstanceOf(DuckDBError);
    await delay(150);

    expect(reconnectAttempts).toEqual([]);
    expect(exhaustedEvents).toEqual([]);
    expect(client.isConnected()).toBe(false);
  });
});
