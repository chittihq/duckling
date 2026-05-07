import config from '../config';
import logger from '../logger';
import type { DatabaseConfig } from '../database/databaseConfig';

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

  constructor(databaseId: string, dbConfig: DatabaseConfig) {
    this.databaseId = databaseId;
    this.dbConfig = dbConfig;
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
    return this.request({
      path: `/api/v1/peers/create`,
      body: {
        peer: {
          name: this.getSourcePeerName(),
          type: 3,
          postgres_config: {
            connection_string: this.dbConfig.mysqlConnectionString,
          },
        },
        allow_update: true,
      },
    });
  }

  async createClickHouseTargetPeer(): Promise<unknown> {
    return this.request({
      path: `/api/v1/peers/create`,
      body: {
        peer: {
          name: this.getTargetPeerName(),
          type: 8,
          clickhouse_config: {
            host: config.peerdb.clickhouseHost,
            port: config.peerdb.clickhousePort,
            user: config.clickhouse.username,
            password: config.clickhouse.password,
            database: this.dbConfig.clickhouseDatabase,
            disable_tls: !config.peerdb.clickhouseTls,
            s3_path: `s3://${config.rustfs.bucket}/${this.databaseId}`,
            access_key_id: config.rustfs.accessKeyId,
            secret_access_key: config.rustfs.secretAccessKey,
            region: config.rustfs.region,
            endpoint: config.rustfs.endpoint,
          },
        },
        allow_update: true,
      },
    });
  }

  async createMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/flows/cdc/create`,
      body: {
        connection_configs: {
          flow_job_name: this.getMirrorName(tableName),
          source_name: this.getSourcePeerName(),
          destination_name: this.getTargetPeerName(),
          table_mappings: [{
            source_table_identifier: tableName.includes('.') ? tableName : `public.${tableName}`,
            destination_table_identifier: tableName,
          }],
          max_batch_size: config.sync.batchSize,
          idle_timeout_seconds: Math.max(1, config.sync.intervalMinutes * 60),
          publication_name: '',
          do_initial_snapshot: true,
          snapshot_num_rows_per_partition: config.sync.fullSyncBatchSize,
          snapshot_max_parallel_workers: 4,
          snapshot_num_tables_in_parallel: 1,
          resync: false,
          initial_snapshot_only: false,
          soft_delete_col_name: '_peerdb_is_deleted',
          synced_at_col_name: '_peerdb_synced_at',
        }
      },
    });
  }

  async resyncMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/flows/cdc/create`,
      body: {
        connection_configs: {
          flow_job_name: this.getMirrorName(tableName),
          source_name: this.getSourcePeerName(),
          destination_name: this.getTargetPeerName(),
          table_mappings: [{
            source_table_identifier: tableName.includes('.') ? tableName : `public.${tableName}`,
            destination_table_identifier: tableName,
          }],
          max_batch_size: config.sync.batchSize,
          idle_timeout_seconds: Math.max(1, config.sync.intervalMinutes * 60),
          publication_name: '',
          do_initial_snapshot: true,
          snapshot_num_rows_per_partition: config.sync.fullSyncBatchSize,
          snapshot_max_parallel_workers: 4,
          snapshot_num_tables_in_parallel: 1,
          resync: true,
          initial_snapshot_only: false,
          soft_delete_col_name: '_peerdb_is_deleted',
          synced_at_col_name: '_peerdb_synced_at',
        }
      },
    });
  }

  async pauseMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors/state_change`,
      body: {
        flowJobName: this.getMirrorName(tableName),
        requestedFlowState: 'STATUS_PAUSED',
      },
    });
  }

  async resumeMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors/state_change`,
      body: {
        flowJobName: this.getMirrorName(tableName),
        requestedFlowState: 'STATUS_RUNNING',
      },
    });
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
