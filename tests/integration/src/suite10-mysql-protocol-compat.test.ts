import { describe, test, expect } from 'vitest';
import {
  mysqlProtocolExecute,
  mysqlProtocolQuery,
} from './helpers/mysqlProtocol.js';
import { DB_ID } from './helpers/config.js';

function pickValue(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return String(value);
  }
  return '';
}

describe('Suite 10: MySQL Protocol Compatibility', () => {
  test('SHOW DATABASES includes configured database', async () => {
    const rows = await mysqlProtocolQuery('SHOW DATABASES');
    const dbs = rows.map(row => pickValue(row, 'Database', 'database', 'SCHEMA_NAME'));
    expect(dbs).toContain(DB_ID);
  });

  test('INFORMATION_SCHEMA.SCHEMATA returns Duckling database ids', async () => {
    const rows = await mysqlProtocolQuery(
      "SELECT SCHEMA_NAME AS DatabaseName FROM INFORMATION_SCHEMA.SCHEMATA " +
      "WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') " +
      'ORDER BY SCHEMA_NAME',
    );
    const dbs = rows.map(row => pickValue(row, 'DatabaseName', 'SCHEMA_NAME'));
    expect(dbs).toContain(DB_ID);
  });

  test('INFORMATION_SCHEMA.ROUTINES metadata query returns empty set, not error', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT ROUTINE_SCHEMA as function_schema,ROUTINE_NAME as function_name,` +
      `ROUTINE_DEFINITION as create_statement,ROUTINE_TYPE as function_type ` +
      `FROM information_schema.routines where ROUTINE_SCHEMA='${DB_ID}'`,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  test('INFORMATION_SCHEMA.TABLES size projection query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT data_length AS data_size, index_length AS index_size, ` +
      `(data_length + index_length) AS total_size, table_comment AS comment ` +
      `FROM information_schema.TABLES ` +
      `WHERE table_schema = '${DB_ID}' AND table_name = 'users_with_timestamps'`,
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(pickValue(row, 'data_size')).not.toBe('');
    expect(pickValue(row, 'index_size')).not.toBe('');
    expect(pickValue(row, 'total_size')).not.toBe('');
    expect(row).toHaveProperty('comment');
  });

  test('INFORMATION_SCHEMA.STATISTICS primary-key query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT column_name as column_name FROM information_schema.statistics ` +
      `WHERE table_schema = '${DB_ID}' AND table_name = 'users_with_timestamps' ` +
      `AND index_name = 'PRIMARY' ORDER BY seq_in_index ASC`,
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  test('INFORMATION_SCHEMA.COLUMNS enum projection query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT table_name as table_name,column_name as column_name,column_type as column_type ` +
      `FROM information_schema.columns ` +
      `WHERE table_schema='${DB_ID}' AND table_name='users_with_timestamps' AND data_type='enum'`,
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  test('INFORMATION_SCHEMA.COLUMNS MySQL compatibility projection succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT ordinal_position as ordinal_position,column_name as column_name,column_type AS data_type,` +
      `character_set_name as character_set,collation_name as collation,is_nullable as is_nullable,` +
      `column_default as column_default,extra as extra,column_name AS foreign_key,column_comment AS comment ` +
      `FROM information_schema.columns WHERE table_schema='${DB_ID}' AND table_name='users_with_timestamps'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row).toHaveProperty('data_type');
    expect(row).toHaveProperty('character_set');
    expect(row).toHaveProperty('extra');
    expect(row).toHaveProperty('comment');
  });

  test('Backtick-qualified table queries succeed', async () => {
    const sampleRows = await mysqlProtocolQuery(
      `SELECT * FROM \`${DB_ID}\`.\`users_with_timestamps\` LIMIT 3 OFFSET 0`,
    );
    expect(sampleRows.length).toBeGreaterThan(0);

    const countRows = await mysqlProtocolQuery(
      `SELECT COUNT(*) as count FROM \`${DB_ID}\`.\`users_with_timestamps\``,
    );
    expect(pickValue(countRows[0], 'count', 'COUNT(*)')).toBe('5');
  });

  test('INFORMATION_SCHEMA.TABLES table_rows projection succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT table_rows as count FROM information_schema.TABLES ` +
      `WHERE TABLE_SCHEMA='${DB_ID}' AND TABLE_NAME='users_with_timestamps'`,
    );
    expect(rows.length).toBe(1);
    const count = Number(pickValue(rows[0], 'count'));
    expect(Number.isFinite(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Prepared statement path is explicitly unsupported (known rough edge)', async () => {
    await expect(
      mysqlProtocolExecute('SET NAMES utf8'),
    ).rejects.toThrow(/Prepared statements are not supported/i);
  });
});
