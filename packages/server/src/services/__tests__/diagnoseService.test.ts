import { describe, expect, test, vi } from 'vitest';
import { diagnoseDatabase, DiagnoseProgressEvent } from '../diagnoseService';
import MySQLConnection from '../../database/mysql';

describe('diagnoseDatabase progress events', () => {
  test('emits progress ticks for server checks and table checks', async () => {
    const variables: Record<string, string> = {
      character_set_server: 'utf8mb4',
      collation_server: 'utf8mb4_0900_ai_ci',
      log_bin: 'ON',
      binlog_format: 'ROW',
      binlog_row_image: 'FULL',
      binlog_row_metadata: 'FULL',
      gtid_mode: 'ON',
      binlog_expire_logs_seconds: '2592000',
    };
    const mysql = {
      execute: vi.fn(async (query: string, params?: string[]) => {
        if (query === 'SELECT 1') return [{ 1: 1 }];
        if (query === 'SELECT @@sql_mode as mode') return [{ mode: 'NO_ZERO_DATE' }];
        if (query.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'users', TABLE_COLLATION: 'utf8mb4_0900_ai_ci' }];
        if (query === 'SHOW VARIABLES LIKE ?') {
          const key = params?.[0];
          return key && variables[key] !== undefined ? [{ Value: variables[key] }] : [];
        }
        return [];
      }),
      getVariable: vi.fn(async (name: string) => variables[name] ?? null),
      getCurrentUserGrants: vi.fn(async () => [
        "GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'user'@'%'",
      ]),
      getTables: vi.fn(async () => ['users']),
      getAllTableRowCountsFast: vi.fn(async () => new Map([['users', 123]])),
      getTableSchema: vi.fn(async () => ([
        { Field: 'id', Key: 'PRI', Type: 'bigint' },
        { Field: 'updatedAt', Key: '', Type: 'timestamp' },
      ])),
    } as unknown as MySQLConnection;

    const events: DiagnoseProgressEvent[] = [];
    const result = await diagnoseDatabase(mysql, (event) => events.push(event));

    expect(result.summary.totalTables).toBe(1);
    expect(events.some(event => event.name === 'Connection' && event.status === 'pass')).toBe(true);
    // CDC capability checks: all requirements met → every check passes.
    for (const name of ['Binlog enabled', 'Binlog format', 'Binlog row image', 'Binlog row metadata', 'GTID mode', 'Replication grants', 'Binlog retention', 'CDC readiness']) {
      expect(events).toContainEqual(expect.objectContaining({ name, status: 'pass' }));
    }
  });

  test('unmet CDC requirements show fail (✗) and the verdict falls back to polling', async () => {
    // Mirrors a DigitalOcean-managed MySQL default: binlog on but MINIMAL row
    // metadata, which is the single blocker for peerdb mode.
    const variables: Record<string, string> = {
      character_set_server: 'utf8mb4',
      collation_server: 'utf8mb4_0900_ai_ci',
      log_bin: 'ON',
      binlog_format: 'ROW',
      binlog_row_image: 'FULL',
      binlog_row_metadata: 'MINIMAL',
      gtid_mode: 'ON',
      binlog_expire_logs_seconds: '259200',
    };
    const mysql = {
      execute: vi.fn(async (query: string, params?: string[]) => {
        if (query === 'SELECT 1') return [{ 1: 1 }];
        if (query === 'SELECT @@sql_mode as mode') return [{ mode: '' }];
        if (query.includes('information_schema.TABLES')) return [];
        if (query === 'SHOW VARIABLES LIKE ?') {
          const key = params?.[0];
          return key && variables[key] !== undefined ? [{ Value: variables[key] }] : [];
        }
        return [];
      }),
      getVariable: vi.fn(async (name: string) => variables[name] ?? null),
      getCurrentUserGrants: vi.fn(async () => ["GRANT SELECT ON *.* TO 'user'@'%'"]),
      getTables: vi.fn(async () => []),
      getAllTableRowCountsFast: vi.fn(async () => new Map()),
      getTableSchema: vi.fn(async () => []),
    } as unknown as MySQLConnection;

    const events: DiagnoseProgressEvent[] = [];
    await diagnoseDatabase(mysql, (event) => events.push(event));

    expect(events).toContainEqual(expect.objectContaining({ name: 'Binlog row metadata', status: 'fail' }));
    expect(events).toContainEqual(expect.objectContaining({ name: 'Replication grants', status: 'fail', detail: 'Missing: REPLICATION SLAVE, REPLICATION CLIENT' }));
    // 3-day retention → advisory warning, not a failure.
    expect(events).toContainEqual(expect.objectContaining({ name: 'Binlog retention', status: 'warn' }));
    expect(events).toContainEqual(expect.objectContaining({ name: 'CDC readiness', status: 'warn' }));
    // Met requirements still pass individually.
    expect(events).toContainEqual(expect.objectContaining({ name: 'Binlog format', status: 'pass' }));
  });

  test('emits failed connection tick and exits early when mysql is unavailable', async () => {
    const mysql = {
      execute: vi.fn(async () => {
        throw new Error('Connection down');
      }),
      getTables: vi.fn(async () => []),
      getAllTableRowCountsFast: vi.fn(async () => new Map()),
      getTableSchema: vi.fn(async () => []),
    } as unknown as MySQLConnection;

    const events: DiagnoseProgressEvent[] = [];
    const result = await diagnoseDatabase(mysql, (event) => events.push(event));

    expect(result.tables).toHaveLength(0);
    expect(events).toEqual([
      { name: 'Connection', status: 'fail', detail: 'Connection down' },
    ]);
  });
});
