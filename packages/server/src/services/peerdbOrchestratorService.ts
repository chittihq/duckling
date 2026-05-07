import config from '../config';
import logger from '../logger';
import type { DatabaseConfig } from '../database/databaseConfig';
import PeerDBSqlClient from './peerdbSqlClient';

type PeerDBHttpOptions = {
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
};

type PeerDBMirrorStatus = {
  flowJobName: string;
  currentFlowState?: string;
  ok?: boolean;
  errorMessage?: string;
  [key: string]: unknown;
};

class PeerDBOrchestratorService {
  private readonly databaseId: string;
  private readonly dbConfig: DatabaseConfig;
  private readonly sqlClient: PeerDBSqlClient;

  constructor(databaseId: string, dbConfig: DatabaseConfig) {
    this.databaseId = databaseId;
    this.dbConfig = dbConfig;
    this.sqlClient = new PeerDBSqlClient();
  }

  getSourcePeerName(): string {
    return this.dbConfig.peerdb?.sourcePeerName || `${config.peerdb.sourcePeerPrefix}_${this.databaseId}`;
  }

  getTargetPeerName(): string {
    return this.dbConfig.peerdb?.targetPeerName || `${config.peerdb.targetPeerPrefix}_${this.databaseId}`;
  }

  getMirrorPrefix(): string {
    return this.dbConfig.peerdb?.mirrorPrefix || `${config.peerdb.mirrorPrefix}_${this.databaseId}`;
  }

  getMirrorName(tableName: string): string {
    return `${this.getMirrorPrefix()}_${tableName}`;
  }

  async listMirrors(): Promise<PeerDBMirrorStatus[]> {
    const knownMirrors = this.dbConfig.peerdb?.mirrors || [];
    const mirrors: PeerDBMirrorStatus[] = [];
    for (const mirror of knownMirrors) {
      const status = await this.getMirrorStatus(mirror.table);
      if (status) {
        mirrors.push(status);
      }
    }
    return mirrors;
  }

  async getMirrorStatus(tableName: string): Promise<PeerDBMirrorStatus | null> {
    const mirrorName = this.getMirrorName(tableName);
    const response = await this.request({
      path: `/api/v1/mirrors/status`,
      body: {
        flowJobName: mirrorName,
        includeFlowInfo: true,
      },
    });
    if (!response || response.ok === false && response.currentFlowState === 'STATUS_UNKNOWN') {
      return null;
    }
    return response as PeerDBMirrorStatus;
  }

  async createMySQLSourcePeer(): Promise<unknown> {
    const uri = new URL(this.dbConfig.mysqlConnectionString);
    const mysqlFlavor = this.getMySQLFlavor();
    const replicationMechanism = this.getReplicationMechanism();
    const sql = [
      `CREATE PEER ${this.q(this.getSourcePeerName())} FROM MYSQL WITH (`,
      `host='${this.escape(uri.hostname)}',`,
      `port=${uri.port ? Number(uri.port) : 3306},`,
      `user='${this.escape(decodeURIComponent(uri.username))}',`,
      `password='${this.escape(decodeURIComponent(uri.password))}',`,
      `database='${this.escape(uri.pathname.replace(/^\//, ''))}',`,
      `disable_tls=${this.getMySQLDisableTls() ? 'true' : 'false'},`,
      `flavor='${mysqlFlavor}',`,
      `replication_mechanism='${replicationMechanism}'`,
      `);`,
    ].join(' ');
    return this.sqlClient.execute(sql);
  }

  async createClickHouseTargetPeer(): Promise<unknown> {
    const sql = [
      `CREATE PEER ${this.q(this.getTargetPeerName())} FROM CLICKHOUSE WITH (`,
      `host='${this.escape(config.peerdb.clickhouseHost)}',`,
      `port=${config.peerdb.clickhousePort},`,
      `user='${this.escape(config.clickhouse.username)}',`,
      `password='${this.escape(config.clickhouse.password)}',`,
      `database='${this.escape(this.dbConfig.clickhouseDatabase)}',`,
      `disable_tls=${config.peerdb.clickhouseTls ? 'false' : 'true'},`,
      `s3_path='s3://${this.escape(config.rustfs.bucket)}/${this.escape(this.databaseId)}',`,
      `access_key_id='${this.escape(config.rustfs.accessKeyId)}',`,
      `secret_access_key='${this.escape(config.rustfs.secretAccessKey)}',`,
      `region='${this.escape(config.rustfs.region)}',`,
      `endpoint='${this.escape(config.rustfs.endpoint)}'`,
      `);`,
    ].join(' ');
    return this.sqlClient.execute(sql);
  }

  async createMirror(tableName: string): Promise<unknown> {
    const sourceTable = tableName.includes('.') ? tableName : `public.${tableName}`;
    const sql = [
      `CREATE MIRROR IF NOT EXISTS ${this.q(this.getMirrorName(tableName))}`,
      `FROM ${this.q(this.getSourcePeerName())} TO ${this.q(this.getTargetPeerName())}`,
      `WITH TABLE MAPPING (${sourceTable}:${tableName})`,
      `WITH (`,
      `do_initial_copy = true,`,
      `max_batch_size = ${config.sync.batchSize},`,
      `sync_interval = ${Math.max(1, config.sync.intervalMinutes * 60)},`,
      `snapshot_num_rows_per_partition = ${config.sync.fullSyncBatchSize},`,
      `snapshot_max_parallel_workers = 4,`,
      `snapshot_num_tables_in_parallel = 1,`,
      `soft_delete = true,`,
      `synced_at_col_name = '_peerdb_synced_at',`,
      `soft_delete_col_name = '_peerdb_is_deleted'`,
      `);`,
    ].join(' ');
    return this.sqlClient.execute(sql);
  }

  async resyncMirror(tableName: string): Promise<unknown> {
    return this.sqlClient.execute(`RESYNC MIRROR IF EXISTS ${this.q(this.getMirrorName(tableName))};`);
  }

  async pauseMirror(tableName: string): Promise<unknown> {
    return this.sqlClient.execute(`PAUSE MIRROR IF EXISTS ${this.q(this.getMirrorName(tableName))};`);
  }

  async resumeMirror(tableName: string): Promise<unknown> {
    return this.sqlClient.execute(`RESUME MIRROR IF EXISTS ${this.q(this.getMirrorName(tableName))};`);
  }

  private q(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private getMySQLFlavor(): 'mysql' | 'mariadb' {
    return this.dbConfig.peerdb?.mysqlFlavor || (config.peerdb.mysqlFlavor === 'mariadb' ? 'mariadb' : 'mysql');
  }

  private getMySQLDisableTls(): boolean {
    return this.dbConfig.peerdb?.mysqlDisableTls ?? config.peerdb.mysqlDisableTls;
  }

  private getReplicationMechanism(): 'auto' | 'gtid' | 'filepos' {
    const mechanism = this.dbConfig.peerdb?.replicationMechanism || config.peerdb.mysqlReplicationMechanism;
    if (mechanism === 'gtid' || mechanism === 'filepos') {
      return mechanism;
    }
    return 'auto';
  }

  private escape(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async request(options: PeerDBHttpOptions): Promise<any> {
    const method = options.method || 'POST';
    const url = new URL(options.path, config.peerdb.uiUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.peerdb.apiKey) {
      headers.Authorization = `Basic ${Buffer.from(`:${config.peerdb.apiKey}`).toString('base64')}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
    });

    const text = await response.text();
    const data = text ? this.tryParseJson(text) : null;

    if (!response.ok) {
      logger.error(`PeerDB request failed for ${this.databaseId}: ${method} ${url}`, {
        status: response.status,
        body: data || text,
      });
      throw new Error(`PeerDB request failed (${response.status})`);
    }

    return data;
  }

  private tryParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

export default PeerDBOrchestratorService;
