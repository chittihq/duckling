import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import ClickHouseSyncService from './clickhouseSyncService';
import logger from '../logger';

type CdcStatus = {
  isRunning: boolean;
  pollIntervalMs: number;
  lastSuccessfulRun: string | null;
  lastError: string | null;
  eventsProcessed: number;
  insertsProcessed: number;
  updatesProcessed: number;
  deletesProcessed: number;
  errors: number;
  filename: string;
  position: number;
};

type TableSnapshot = {
  count: number;
  changeToken: string | null;
};

class CdcCompatibilityService {
  private static instances: Map<string, CdcCompatibilityService> = new Map();

  private readonly databaseId: string;
  private readonly syncService: ClickHouseSyncService;
  private readonly clickhouse: ClickHouseConnection;
  private readonly mysql: MySQLConnection;
  private readonly pollIntervalMs = 1000;
  private readonly filename = 'synthetic-clickhouse-poll';
  private timer: NodeJS.Timeout | null = null;
  private cycleInProgress = false;
  private trackedTables: Set<string> = new Set();
  private tableSnapshots: Map<string, TableSnapshot> = new Map();
  private status: CdcStatus = {
    isRunning: false,
    pollIntervalMs: 1000,
    lastSuccessfulRun: null,
    lastError: null,
    eventsProcessed: 0,
    insertsProcessed: 0,
    updatesProcessed: 0,
    deletesProcessed: 0,
    errors: 0,
    filename: 'synthetic-clickhouse-poll',
    position: 0,
  };

  private constructor(
    databaseId: string,
    syncService: ClickHouseSyncService,
    clickhouse: ClickHouseConnection,
    mysql: MySQLConnection,
  ) {
    this.databaseId = databaseId;
    this.syncService = syncService;
    this.clickhouse = clickhouse;
    this.mysql = mysql;
  }

  static getInstance(
    databaseId: string,
    syncService: ClickHouseSyncService,
    clickhouse: ClickHouseConnection,
    mysql: MySQLConnection,
  ): CdcCompatibilityService {
    if (!CdcCompatibilityService.instances.has(databaseId)) {
      CdcCompatibilityService.instances.set(
        databaseId,
        new CdcCompatibilityService(databaseId, syncService, clickhouse, mysql),
      );
    }
    return CdcCompatibilityService.instances.get(databaseId)!;
  }

  async start(): Promise<CdcStatus> {
    await this.loadCheckpoint();

    if (this.status.isRunning) {
      return this.getStatus();
    }

    this.status.isRunning = true;
    await this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.pollIntervalMs);

    return this.getStatus();
  }

  stop(): CdcStatus {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status.isRunning = false;
    return this.getStatus();
  }

  getStatus(): CdcStatus {
    return { ...this.status };
  }

  private async loadCheckpoint(): Promise<void> {
    const rows = await this.clickhouse.execute(
      `SELECT filename, position
       FROM cdc_binlog_position
       WHERE database_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [this.databaseId],
    );

    if (rows.length === 0) {
      await this.saveCheckpoint(0);
      return;
    }

    const row = rows[0];
    this.status.filename = typeof row.filename === 'string' ? row.filename : this.filename;
    this.status.position = Number(row.position || 0);
  }

  private async runCycle(): Promise<void> {
    if (!this.status.isRunning || this.cycleInProgress) {
      return;
    }

    this.cycleInProgress = true;

    try {
      const mysqlTables = await this.mysql.getTables();
      const visibleClickHouseTables = new Set(await this.clickhouse.getTables());

      const missingTrackedTables = Array.from(this.trackedTables).filter(
        (tableName) => !visibleClickHouseTables.has(tableName),
      );

      if (missingTrackedTables.length > 0) {
        this.status.errors += 1;
        this.status.lastError = `Tracked table missing from ClickHouse: ${missingTrackedTables.join(', ')}`;
        logger.warn(`CDC compatibility cycle blocked for ${this.databaseId}: ${this.status.lastError}`);
        return;
      }

      const nextSnapshots = new Map<string, TableSnapshot>();
      for (const tableName of mysqlTables) {
        nextSnapshots.set(tableName, await this.captureSnapshot(tableName));
      }

      let inserts = 0;
      let deletes = 0;
      let updates = 0;

      if (this.tableSnapshots.size === 0) {
        await this.syncService.fullSync();
      } else {
        for (const tableName of mysqlTables) {
          const previous = this.tableSnapshots.get(tableName);
          const next = nextSnapshots.get(tableName)!;

          if (!previous) {
            const result = await this.syncService.forceFullSyncTable(tableName);
            if (result.status !== 'success') {
              throw new Error(result.error || `Full sync failed for ${tableName}`);
            }
            inserts += next.count;
            continue;
          }

          if (previous.count > next.count) {
            const result = await this.syncService.forceFullSyncTable(tableName);
            if (result.status !== 'success') {
              throw new Error(result.error || `Full sync failed for ${tableName}`);
            }

            deletes += previous.count - next.count;
            continue;
          }

          const result = await this.syncService.syncSingleTable(tableName);
          if (result.status !== 'success') {
            throw new Error(result.error || `Incremental sync failed for ${tableName}`);
          }

          const delta = next.count - previous.count;
          if (delta > 0) {
            inserts += delta;
          } else if (
            delta === 0 &&
            previous.changeToken !== null &&
            next.changeToken !== null &&
            previous.changeToken !== next.changeToken &&
            result.recordsProcessed > 0
          ) {
            updates += result.recordsProcessed;
          }
        }
      }

      this.status.insertsProcessed += inserts;
      this.status.deletesProcessed += deletes;
      this.status.updatesProcessed += updates;
      this.status.eventsProcessed += inserts + deletes + updates;

      this.tableSnapshots = nextSnapshots;
      this.trackedTables = new Set(mysqlTables);
      this.status.position += 1;
      this.status.lastSuccessfulRun = new Date().toISOString();
      this.status.lastError = null;
      await this.saveCheckpoint(this.status.position);
    } catch (error) {
      this.status.errors += 1;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      logger.error(`CDC compatibility cycle failed for ${this.databaseId}:`, error);
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async saveCheckpoint(position: number): Promise<void> {
    this.status.filename = this.filename;
    this.status.position = position;
    await this.clickhouse.insert('cdc_binlog_position', [{
      database_id: this.databaseId,
      filename: this.filename,
      position,
      updated_at: new Date().toISOString().slice(0, 23).replace('T', ' '),
    }]);
  }

  private async captureSnapshot(tableName: string): Promise<TableSnapshot> {
    const count = await this.mysql.getTableRowCount(tableName);
    const changeToken = await this.mysql.getTableChangeToken(tableName);
    return { count, changeToken };
  }
}

export default CdcCompatibilityService;
