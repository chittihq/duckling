#!/usr/bin/env ts-node

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

type ConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

function getConnectionConfig(): ConnectionConfig {
  const host = process.env.MYSQL_PROTOCOL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PROTOCOL_PORT || 3307);
  const user = process.env.MYSQL_PROTOCOL_USER || 'duckling';
  const password = process.env.MYSQL_PROTOCOL_PASSWORD || process.env.DUCKLING_API_KEY || '';
  const database =
    process.env.MYSQL_PROTOCOL_DATABASE ||
    process.env.MYSQL_PROTOCOL_DEFAULT_DB ||
    undefined;

  if (!Number.isFinite(port)) {
    throw new Error(`Invalid MYSQL_PROTOCOL_PORT: ${process.env.MYSQL_PROTOCOL_PORT}`);
  }

  if (!password) {
    throw new Error('Missing password. Set MYSQL_PROTOCOL_PASSWORD or DUCKLING_API_KEY.');
  }

  return { host, port, user, password, database };
}

async function connectWithFallback(cfg: ConnectionConfig): Promise<mysql.Connection> {
  try {
    return await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ER_BAD_DB_ERROR' && cfg.database) {
      return await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
      });
    }
    throw error;
  }
}

function getQueriesFromArgs(args: string[]): string[] {
  if (args.length > 0) {
    return [args.join(' ')];
  }

  return [
    'SELECT 1 AS ok',
    'SELECT DATABASE() AS current_database',
    'SHOW TABLES',
  ];
}

async function executeQuery(connection: mysql.Connection, sql: string): Promise<unknown> {
  const [rows] = await connection.query(sql);
  return JSON.parse(
    JSON.stringify(rows, (_k, value) => (typeof value === 'bigint' ? value.toString() : value))
  );
}

async function run(): Promise<void> {
  const queries = getQueriesFromArgs(process.argv.slice(2));
  const cfg = getConnectionConfig();

  let connection: mysql.Connection | null = null;
  try {
    connection = await connectWithFallback(cfg);

    const results: Array<{ sql: string; rows?: unknown; error?: string }> = [];
    for (const sql of queries) {
      try {
        const rows = await executeQuery(connection, sql);
        results.push({ sql, rows });
      } catch (error) {
        results.push({
          sql,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(JSON.stringify({
      connected: true,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      database: cfg.database ?? null,
      results,
    }, null, 2));
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    connected: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
