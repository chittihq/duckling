import { apiPost } from './api.js';
import { DB_ID } from './config.js';
import mysql from 'mysql2/promise';

export async function mysqlQuery(sql: string): Promise<any> {
  return apiPost(`/api/query?db=${DB_ID}`, { sql, database: 'mysql' });
}

export async function mysqlScalar(sql: string, field: string): Promise<string> {
  const data = await mysqlQuery(sql);
  const row = data?.result?.[0];
  if (!row) return 'null';
  const val = row[field];
  if (val === null || val === undefined) return 'null';
  return String(val);
}

export async function mysqlExec(sql: string): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.DUCKLING_TEST_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.DUCKLING_TEST_MYSQL_PORT || '3308'),
    user: process.env.DUCKLING_TEST_MYSQL_USER || 'integration',
    password: process.env.DUCKLING_TEST_MYSQL_PASSWORD || 'integrationpass',
    database: process.env.DUCKLING_TEST_MYSQL_DATABASE || 'integration_db',
    charset: 'utf8mb4',
    multipleStatements: true,
  });

  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}
