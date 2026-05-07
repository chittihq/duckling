import { Client } from 'pg';
import config from '../config';

class PeerDBSqlClient {
  private createClient(): Client {
    return new Client({
      host: config.peerdb.sqlHost,
      port: config.peerdb.sqlPort,
      user: config.peerdb.sqlUser,
      password: config.peerdb.sqlPassword,
      database: config.peerdb.sqlDatabase,
    });
  }

  async execute(sql: string, values?: unknown[]): Promise<void> {
    const client = this.createClient();
    await client.connect();
    try {
      await client.query(sql, values);
    } finally {
      await client.end();
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> {
    const client = this.createClient();
    await client.connect();
    try {
      const result = await client.query(sql, values);
      return result.rows as T[];
    } finally {
      await client.end();
    }
  }
}

export default PeerDBSqlClient;
