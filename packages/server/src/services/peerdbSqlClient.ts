import { Client } from 'pg';
import config from '../config';

class PeerDBSqlClient {
  async execute(sql: string): Promise<void> {
    const client = new Client({
      host: config.peerdb.sqlHost,
      port: config.peerdb.sqlPort,
      user: config.peerdb.sqlUser,
      password: config.peerdb.sqlPassword,
      database: config.peerdb.sqlDatabase,
    });

    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }
}

export default PeerDBSqlClient;
