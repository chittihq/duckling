import { describe, expect, test, vi } from 'vitest';
import { diagnoseDatabase, DiagnoseProgressEvent } from '../diagnoseService';
import MySQLConnection from '../../database/mysql';

describe('diagnoseDatabase progress events', () => {
  test('emits progress ticks for server checks and table checks', async () => {
    const mysql = {
      execute: vi.fn(async (query: string, params?: string[]) => {
        if (query === 'SELECT 1') return [{ 1: 1 }];
        if (query === 'SELECT @@sql_mode as mode') return [{ mode: 'NO_ZERO_DATE' }];
        if (query.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'users', TABLE_COLLATION: 'utf8mb4_0900_ai_ci' }];
        if (query === 'SHOW VARIABLES LIKE ?') {
          const key = params?.[0];
          if (key === 'character_set_server') return [{ Value: 'utf8mb4' }];
          if (key === 'collation_server') return [{ Value: 'utf8mb4_0900_ai_ci' }];
          if (key === 'log_bin') return [{ Value: 'ON' }];
          if (key === 'binlog_format') return [{ Value: 'ROW' }];
          if (key === 'binlog_row_image') return [{ Value: 'FULL' }];
          return [];
        }
        return [];
      }),
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
    expect(events.some(event => event.name === 'Table users' && event.status === 'pass')).toBe(true);
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
