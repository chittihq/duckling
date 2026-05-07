import config from '../config';
import logger from '../logger';
import type { DatabaseConfig } from '../database/databaseConfig';

type PeerDBHttpOptions = {
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
};

type PeerDBMirrorStatus = {
  name: string;
  status?: string;
  flow_status?: string;
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
    const response = await this.request({
      method: 'GET',
      path: `/api/v1/mirrors`,
    });
    const mirrors = Array.isArray(response) ? response : (response?.items || response?.mirrors || []);
    return Array.isArray(mirrors) ? mirrors as PeerDBMirrorStatus[] : [];
  }

  async getMirrorStatus(tableName: string): Promise<PeerDBMirrorStatus | null> {
    const mirrorName = this.getMirrorName(tableName);
    const mirrors = await this.listMirrors();
    return mirrors.find((mirror) => mirror.name === mirrorName) || null;
  }

  async createMySQLSourcePeer(): Promise<unknown> {
    return this.request({
      path: `/api/v1/peers`,
      body: {
        name: this.getSourcePeerName(),
        type: 'mysql',
        config: {
          connection_string: this.dbConfig.mysqlConnectionString,
        },
      },
    });
  }

  async createClickHouseTargetPeer(): Promise<unknown> {
    return this.request({
      path: `/api/v1/peers`,
      body: {
        name: this.getTargetPeerName(),
        type: 'clickhouse',
        config: {
          host: config.peerdb.clickhouseHost,
          port: config.peerdb.clickhousePort,
          user: config.clickhouse.username,
          password: config.clickhouse.password,
          database: this.dbConfig.clickhouseDatabase,
          tls: config.peerdb.clickhouseTls,
          s3_endpoint: config.rustfs.endpoint,
          s3_access_key_id: config.rustfs.accessKeyId,
          s3_secret_access_key: config.rustfs.secretAccessKey,
          s3_region: config.rustfs.region,
          s3_bucket: config.rustfs.bucket,
          s3_path_style: config.rustfs.usePathStyle,
        },
      },
    });
  }

  async createMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors`,
      body: {
        name: this.getMirrorName(tableName),
        source_peer: this.getSourcePeerName(),
        destination_peer: this.getTargetPeerName(),
        table_mappings: [{
          source_table_identifier: tableName,
          destination_table_identifier: tableName,
        }],
        options: {
          initial_copy_only: false,
          snapshot_num_rows_per_partition: 100000,
          publication_name: `${config.peerdb.defaultFlowJobNamePrefix}_${this.databaseId}_${tableName}`,
        },
      },
    });
  }

  async resyncMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors/${encodeURIComponent(this.getMirrorName(tableName))}/resync`,
      body: {},
    });
  }

  async pauseMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors/${encodeURIComponent(this.getMirrorName(tableName))}/pause`,
      body: {},
    });
  }

  async resumeMirror(tableName: string): Promise<unknown> {
    return this.request({
      path: `/api/v1/mirrors/${encodeURIComponent(this.getMirrorName(tableName))}/resume`,
      body: {},
    });
  }

  private async request(options: PeerDBHttpOptions): Promise<any> {
    const method = options.method || 'POST';
    const url = new URL(options.path, config.peerdb.apiUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.peerdb.apiKey) {
      headers.Authorization = `Bearer ${config.peerdb.apiKey}`;
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
