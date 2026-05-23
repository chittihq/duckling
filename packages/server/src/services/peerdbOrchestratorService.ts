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
    try {
      const response = await this.request({
        method: 'GET',
        path: '/api/v1/mirrors/list',
      });
      const mirrors = Array.isArray((response as any)?.mirrors) ? (response as any).mirrors : [];
      return mirrors
        .filter((mirror: any) =>
          mirror?.sourceName === this.getSourcePeerName() &&
          mirror?.destinationName === this.getTargetPeerName()
        )
        .map((mirror: any) => ({
          flowJobName: mirror.name,
          currentFlowState: mirror.status,
          ok: true,
          sourceName: mirror.sourceName,
          destinationName: mirror.destinationName,
        }));
    } catch (error) {
      logger.warn(`PeerDB mirror list lookup failed for ${this.databaseId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async getMirrorStatus(tableName: string): Promise<PeerDBMirrorStatus | null> {
    const mirrorName = this.getMirrorName(tableName);
    try {
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
    } catch (error) {
      if (this.getErrorStatus(error) === 404) {
        return null;
      }
      logger.warn(`PeerDB HTTP status lookup failed for ${mirrorName}`, {
        databaseId: this.databaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async createMySQLSourcePeer(): Promise<unknown> {
    const uri = new URL(this.dbConfig.mysqlConnectionString);
    const mysqlFlavor = this.getMySQLFlavor();
    const replicationMechanism = this.getReplicationMechanism();
    const setup = this.getMySQLSetupStatements();
    const sql = [
      `CREATE PEER ${this.q(this.getSourcePeerName())} FROM MYSQL WITH (`,
      `host='${this.escape(uri.hostname)}',`,
      `port=${uri.port ? Number(uri.port) : 3306},`,
      `user='${this.escape(decodeURIComponent(uri.username))}',`,
      `password='${this.escape(decodeURIComponent(uri.password))}',`,
      `database='${this.escape(uri.pathname.replace(/^\//, ''))}',`,
      ...(setup.length > 0 ? [`setup='${this.escape(setup.join(';'))}',`] : []),
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

  /**
   * Create a PeerDB mirror for `tableName`. By default does an initial snapshot
   * (existing semantics). Pass `doInitialSnapshot: false` together with the
   * binlog position captured by the bootstrap dump to have PeerDB resume CDC
   * directly from that position without re-snapshotting — see
   * docs/replication-strategy.md.
   */
  async createMirror(
    tableName: string,
    options: {
      doInitialSnapshot?: boolean;
      startPosition?: { mode: 'gtid' | 'filepos'; gtid?: string; file?: string; position?: number } | null;
    } = {},
  ): Promise<unknown> {
    const doInitialSnapshot = options.doInitialSnapshot ?? true;
    const startPosition = options.startPosition ?? null;

    const env: Record<string, string> = {
      PEERDB_NULLABLE: 'true',
    };
    // When bootstrap recorded a binlog position, plumb it through the env so
    // PeerDB's MySQL connector starts the binlog reader at that exact point.
    // The connector recognises these envs (see PeerDB MySQL flow source).
    if (startPosition) {
      if (startPosition.mode === 'gtid' && startPosition.gtid) {
        env.PEERDB_MYSQL_START_GTID = startPosition.gtid;
      } else if (startPosition.mode === 'filepos' && startPosition.file && typeof startPosition.position === 'number') {
        env.PEERDB_MYSQL_START_BINLOG_FILE = startPosition.file;
        env.PEERDB_MYSQL_START_BINLOG_POSITION = String(startPosition.position);
      }
    }

    const payload = {
      connectionConfigs: {
        flowJobName: this.getMirrorName(tableName),
        tableMappings: [{
          sourceTableIdentifier: this.getSourceTableIdentifier(tableName),
          destinationTableIdentifier: tableName,
          partitionKey: '',
          exclude: [],
          columns: [],
          engine: 'CH_ENGINE_REPLACING_MERGE_TREE',
          shardingKey: '',
          policyName: '',
          partitionByExpr: '',
        }],
        maxBatchSize: config.sync.batchSize,
        idleTimeoutSeconds: 10,
        cdcStagingPath: '',
        publicationName: '',
        replicationSlotName: '',
        doInitialSnapshot,
        snapshotNumRowsPerPartition: config.sync.fullSyncBatchSize,
        snapshotNumPartitionsOverride: 0,
        snapshotStagingPath: '',
        snapshotMaxParallelWorkers: 4,
        snapshotNumTablesInParallel: 1,
        resync: false,
        initialSnapshotOnly: false,
        softDeleteColName: '_peerdb_is_deleted',
        syncedAtColName: '_peerdb_synced_at',
        script: '',
        system: 'Q',
        sourceName: this.getSourcePeerName(),
        destinationName: this.getTargetPeerName(),
        env,
        version: 0,
        flags: [],
      },
    };
    const attempts = 10;
    let bootstrappedPeers = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.requestToFlowApi('/v1/flows/cdc/create', payload);
      } catch (error) {
        // Idempotency: a concurrent caller (auto-bootstrap firing alongside
        // an explicit `POST /api/databases/:id/bootstrap`) may have created
        // the same mirror first. PeerDB returns 409 "flow already exists"
        // — treat that as success since the desired end state is reached.
        if (this.isMirrorAlreadyExistsError(error)) {
          logger.info(`PeerDB mirror for ${tableName} already exists; treating as success`, {
            databaseId: this.databaseId,
            mirrorName: this.getMirrorName(tableName),
          });
          return { alreadyExisted: true };
        }
        if (!this.isPeerAvailabilityError(error) || attempt === attempts) {
          throw error;
        }
        if (!bootstrappedPeers) {
          await this.createMySQLSourcePeer();
          await this.createClickHouseTargetPeer();
          bootstrappedPeers = true;
        }
        logger.warn(`PeerDB mirror creation waiting for peer availability`, {
          databaseId: this.databaseId,
          tableName,
          attempt,
          sourcePeer: this.getSourcePeerName(),
          targetPeer: this.getTargetPeerName(),
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(3000);
      }
    }
  }

  /**
   * PeerDB's flow-api returns HTTP 409 with `"flow already exists: <name>"`
   * when a mirror with the same name already exists. Treated as success by
   * `createMirror` for idempotency.
   */
  private isMirrorAlreadyExistsError(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    return status === 409 || /flow already exists/i.test(message);
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

  private getSourceTableIdentifier(tableName: string): string {
    if (tableName.includes('.')) {
      return tableName;
    }
    const uri = new URL(this.dbConfig.mysqlConnectionString);
    const databaseName = uri.pathname.replace(/^\//, '');
    return `${databaseName}.${tableName}`;
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
    return undefined;
  }

  private isPeerAvailabilityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('peers not found');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getMySQLFlavor(): 'mysql' | 'mariadb' {
    return this.dbConfig.peerdb?.mysqlFlavor || (config.peerdb.mysqlFlavor === 'mariadb' ? 'mariadb' : 'mysql');
  }

  private getMySQLDisableTls(): boolean {
    return this.dbConfig.peerdb?.mysqlDisableTls ?? config.peerdb.mysqlDisableTls;
  }

  private getMySQLSetupStatements(): string[] {
    const configured = this.dbConfig.peerdb?.mysqlSetup;
    if (configured && configured.length > 0) {
      return configured;
    }
    return config.peerdb.mysqlSetup
      .split(';')
      .map((stmt) => stmt.trim())
      .filter(Boolean);
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
      const error = new Error(`PeerDB request failed (${response.status})`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return data;
  }

  private async requestToFlowApi(path: string, body: unknown): Promise<any> {
    const url = new URL(path, config.peerdb.apiUrl.endsWith('/') ? config.peerdb.apiUrl : `${config.peerdb.apiUrl}/`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? this.tryParseJson(text) : null;

    if (!response.ok) {
      const message = typeof data === 'object' && data && 'message' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).message)
        : `PeerDB flow-api request failed (${response.status})`;
      // Downgrade noise from idempotency-friendly responses. 409 "flow already
      // exists" is caught by createMirror and treated as success — logging it
      // at error level made operators chase a non-issue. Keep info-level
      // breadcrumbs so the request is still traceable.
      const expected409 = response.status === 409 && /flow already exists/i.test(message);
      const logFn = expected409 ? logger.info : logger.error;
      logFn(`PeerDB flow-api request returned ${response.status} for ${this.databaseId}: POST ${url}`, {
        status: response.status,
        body: data || text,
      });
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
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
