import mysql from 'mysql2/promise';
import { API_KEY, DB_ID } from './config.js';

export type ProtocolRow = Record<string, unknown>;

const MYSQL_PROTOCOL_HOST = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_HOST || '127.0.0.1';
const MYSQL_PROTOCOL_PORT = Number(process.env.DUCKLING_TEST_MYSQL_PROTOCOL_PORT || 3309);
const MYSQL_PROTOCOL_USER = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_USER || 'duckling';
const MYSQL_PROTOCOL_PASSWORD = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_PASSWORD || API_KEY;
const MYSQL_PROTOCOL_DATABASE = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_DATABASE || DB_ID;

function normaliseRows(rows: unknown): ProtocolRow[] {
  if (!Array.isArray(rows)) return [];
  return JSON.parse(
    JSON.stringify(rows, (_k, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
}

export async function withMySQLProtocolConnection<T>(
  fn: (connection: mysql.Connection) => Promise<T>,
): Promise<T> {
  const connection = await mysql.createConnection({
    host: MYSQL_PROTOCOL_HOST,
    port: MYSQL_PROTOCOL_PORT,
    user: MYSQL_PROTOCOL_USER,
    password: MYSQL_PROTOCOL_PASSWORD,
    database: MYSQL_PROTOCOL_DATABASE,
  });

  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

export async function mysqlProtocolQuery(sql: string): Promise<ProtocolRow[]> {
  return withMySQLProtocolConnection(async (connection) => {
    const [rows] = await connection.query(sql);
    return normaliseRows(rows);
  });
}

export async function mysqlProtocolExecute(sql: string): Promise<ProtocolRow[]> {
  return withMySQLProtocolConnection(async (connection) => {
    const [rows] = await connection.execute(sql);
    return normaliseRows(rows);
  });
}
