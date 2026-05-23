import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import {
  BootstrapBinlogPosition,
  BootstrapState,
  BootstrapTableProgress,
  DatabaseConfigManager,
} from '../database/databaseConfig';
import ClickHouseSyncService from './clickhouseSyncService';
import logger from '../logger';

export type BootstrapResult = {
  status: 'completed' | 'partial' | 'failed';
  totalTables: number;
  successfulTables: number;
  failedTables: number;
  totalRecords: number;
  durationMs: number;
  binlogPosition: BootstrapBinlogPosition | null;
  errors: Array<{ table: string; error: string }>;
};

export type BootstrapOptions = {
  /**
   * If true, ignore an existing `completed` bootstrap and re-run from scratch.
   * Tables marked completed before this flag was set will be re-dumped.
   */
  force?: boolean;
  /**
   * If true and the previous bootstrap left state as `failed` or `in_progress`,
   * skip tables already marked `completed` and re-run only the rest. Honors the
   * previously captured binlog position.
   */
  resume?: boolean;
  /**
   * Which destination schema to produce:
   *  - 'polling' (default) — `<table>__raw` MergeTree + `<table>` projection
   *    view; consumed by `CdcCompatibilityService` and `/api/query`.
   *  - 'peerdb' — single `<table>` ReplacingMergeTree(_peerdb_synced_at) with
   *    the full `_peerdb_*` metadata column set. **Dormant today.** The
   *    coordinator never selects this branch because PeerDB v0.36's
   *    destination connector rejects pre-populated tables (validates the
   *    `_peerdb_*` columns and errors with "not all PeerDB columns found").
   *    Kept implemented so the day PeerDB upstream supports
   *    attach-to-existing or a per-mirror `cdcStartingFromPosition` field,
   *    flipping the coordinator to use it is a one-line change. See
   *    docs/replication-strategy.md "Implementation status" Phase C.
   */
  targetMode?: 'polling' | 'peerdb';
};

/**
 * Owns Phase 1 of the replication strategy for **polling** and **none** modes
 * (see docs/replication-strategy.md). For `peerdb` mode the coordinator
 * delegates the initial snapshot to PeerDB itself, so this service is not
 * invoked there — see the note on `targetMode: 'peerdb'` above for why.
 *
 * Responsibilities for polling/none:
 *   1. Capture the source MySQL binlog position (informational; reused on
 *      `resume` and kept for diagnostics).
 *   2. Dump every source table into ClickHouse via
 *      `syncService.forceFullSyncTable`.
 *   3. Persist per-table progress + final bootstrap state to `databases.json`.
 */
class BootstrapService {
  private static instances: Map<string, BootstrapService> = new Map();

  private readonly databaseId: string;
  private readonly mysql: MySQLConnection;
  private readonly clickhouse: ClickHouseConnection;
  private readonly syncService: ClickHouseSyncService;
  private inFlight: Promise<BootstrapResult> | null = null;

  private constructor(
    databaseId: string,
    mysql: MySQLConnection,
    clickhouse: ClickHouseConnection,
    syncService: ClickHouseSyncService,
  ) {
    this.databaseId = databaseId;
    this.mysql = mysql;
    this.clickhouse = clickhouse;
    this.syncService = syncService;
  }

  static getInstance(
    databaseId: string,
    mysql: MySQLConnection,
    clickhouse: ClickHouseConnection,
    syncService: ClickHouseSyncService,
  ): BootstrapService {
    if (!BootstrapService.instances.has(databaseId)) {
      BootstrapService.instances.set(
        databaseId,
        new BootstrapService(databaseId, mysql, clickhouse, syncService),
      );
    }
    return BootstrapService.instances.get(databaseId)!;
  }

  isInProgress(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Run Phase 1. Captures the binlog position before any read so PeerDB's
   * binlog reader can resume from there. Concurrent callers join the in-flight
   * bootstrap and receive the same result — useful when auto-bootstrap (fired
   * from POST /api/databases) and an explicit POST /api/databases/:id/bootstrap
   * race.
   */
  async run(options: BootstrapOptions = {}): Promise<BootstrapResult> {
    if (this.inFlight) {
      logger.info(`Bootstrap already running for ${this.databaseId}; joining in-flight run`);
      return this.inFlight;
    }
    this.inFlight = this.runInternal(options).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runInternal(options: BootstrapOptions = {}): Promise<BootstrapResult> {

    const dbManager = DatabaseConfigManager.getInstance();
    const dbConfig = dbManager.getDatabase(this.databaseId);
    if (!dbConfig) {
      throw new Error(`Unknown database '${this.databaseId}'`);
    }

    const existingBootstrap = dbConfig.bootstrap;
    if (
      existingBootstrap?.status === 'completed' &&
      !options.force &&
      !options.resume
    ) {
      return {
        status: 'completed',
        totalTables: Object.keys(existingBootstrap.tableProgress || {}).length,
        successfulTables: Object.values(existingBootstrap.tableProgress || {}).filter(
          (t) => t.status === 'completed',
        ).length,
        failedTables: 0,
        totalRecords: Object.values(existingBootstrap.tableProgress || {}).reduce(
          (sum, t) => sum + (t.recordsProcessed || 0),
          0,
        ),
        durationMs: 0,
        binlogPosition: existingBootstrap.binlogPosition || null,
        errors: [],
      };
    }

    const startedAt = Date.now();
    const resuming = options.resume === true && existingBootstrap?.status !== 'completed';
    const baseProgress = resuming ? { ...(existingBootstrap?.tableProgress || {}) } : {};

    // 1. Capture binlog position before any read so we don't miss writes that
    //    happen during the dump — PeerDB resumes from this exact position.
    //    When resuming a failed bootstrap we keep the original position so the
    //    final handoff to CDC remains consistent end-to-end.
    let binlogPosition: BootstrapBinlogPosition | null = null;
    if (resuming && existingBootstrap?.binlogPosition) {
      binlogPosition = existingBootstrap.binlogPosition;
      logger.info(`Bootstrap resuming for ${this.databaseId} from prior binlog position`, {
        binlogPosition,
      });
    } else {
      const captured = await this.mysql.captureBinlogPosition();
      if (captured) {
        binlogPosition = { ...captured, capturedAt: new Date().toISOString() };
      } else {
        logger.warn(`Bootstrap for ${this.databaseId}: no binlog position available; ` +
          `PeerDB CDC handoff will require an initial snapshot`);
      }
    }

    let tables: string[] = [];
    try {
      tables = await this.mysql.getTables();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistFailure(message, binlogPosition);
      throw error;
    }

    // 2. Mark the bootstrap as in-progress with the captured position.
    dbManager.patchDatabase(this.databaseId, (current) => {
      const tableProgress: Record<string, BootstrapTableProgress> = { ...baseProgress };
      for (const table of tables) {
        if (!tableProgress[table] || (!resuming && tableProgress[table].status !== 'completed')) {
          tableProgress[table] = { status: 'pending', recordsProcessed: 0 };
        }
      }
      current.bootstrap = {
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        binlogPosition: binlogPosition ?? current.bootstrap?.binlogPosition,
        tableProgress,
      };
      return current;
    });

    const result: BootstrapResult = {
      status: 'completed',
      totalTables: tables.length,
      successfulTables: 0,
      failedTables: 0,
      totalRecords: 0,
      durationMs: 0,
      binlogPosition,
      errors: [],
    };

    // 3. Dump each table. We honor `resume` by skipping tables already
    //    completed; otherwise every table gets a fresh forceFullSyncTable.
    for (const tableName of tables) {
      const prior = baseProgress[tableName];
      if (resuming && prior?.status === 'completed') {
        result.successfulTables += 1;
        result.totalRecords += prior.recordsProcessed || 0;
        continue;
      }

      this.markTableStatus(tableName, { status: 'in_progress', recordsProcessed: 0, startedAt: new Date().toISOString() });

      try {
        let recordsProcessed: number;
        if (options.targetMode === 'peerdb') {
          // PeerDB-compatible bootstrap: dumps directly into a
          // ReplacingMergeTree(_peerdb_synced_at) so PeerDB can attach for CDC
          // afterwards without rebuilding the destination schema.
          const peerResult = await this.syncService.bootstrapTableForPeerDB(tableName);
          recordsProcessed = peerResult.recordsProcessed;
        } else {
          const syncResult = await this.syncService.forceFullSyncTable(tableName);
          if (syncResult.status !== 'success') {
            throw new Error(syncResult.error || `Sync reported non-success for ${tableName}`);
          }
          recordsProcessed = syncResult.recordsProcessed;
        }
        this.markTableStatus(tableName, {
          status: 'completed',
          recordsProcessed,
          completedAt: new Date().toISOString(),
        });
        result.successfulTables += 1;
        result.totalRecords += recordsProcessed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.markTableStatus(tableName, {
          status: 'failed',
          recordsProcessed: 0,
          error: message,
        });
        result.failedTables += 1;
        result.errors.push({ table: tableName, error: message });
        logger.error(`Bootstrap table '${tableName}' failed for ${this.databaseId}`, { error });
      }
    }

    // 4. Persist the terminal bootstrap state.
    const overallStatus: BootstrapState['status'] =
      result.failedTables === 0 ? 'completed' : 'failed';
    result.status =
      overallStatus === 'completed' ? 'completed' : (result.successfulTables > 0 ? 'partial' : 'failed');
    result.durationMs = Date.now() - startedAt;

    dbManager.patchDatabase(this.databaseId, (current) => {
      const previous = current.bootstrap ?? { status: 'pending' as const, tableProgress: {} };
      current.bootstrap = {
        status: overallStatus,
        startedAt: previous.startedAt,
        completedAt: new Date().toISOString(),
        binlogPosition: binlogPosition ?? previous.binlogPosition,
        tableProgress: previous.tableProgress,
        error: result.failedTables === 0 ? undefined : result.errors.map((e) => `${e.table}: ${e.error}`).join('; '),
      };
      return current;
    });

    logger.info(`Bootstrap finished for ${this.databaseId}`, {
      status: result.status,
      successfulTables: result.successfulTables,
      failedTables: result.failedTables,
      totalRecords: result.totalRecords,
      durationMs: result.durationMs,
      hasBinlogPosition: Boolean(binlogPosition),
    });

    return result;
  }

  private markTableStatus(table: string, patch: Partial<BootstrapTableProgress>): void {
    const dbManager = DatabaseConfigManager.getInstance();
    dbManager.patchDatabase(this.databaseId, (current) => {
      const bootstrap = current.bootstrap ?? { status: 'in_progress' as const, tableProgress: {} };
      const prior = bootstrap.tableProgress[table] ?? { status: 'pending' as const, recordsProcessed: 0 };
      bootstrap.tableProgress[table] = { ...prior, ...patch } as BootstrapTableProgress;
      current.bootstrap = bootstrap;
      return current;
    });
  }

  private persistFailure(message: string, binlogPosition: BootstrapBinlogPosition | null): void {
    DatabaseConfigManager.getInstance().patchDatabase(this.databaseId, (current) => {
      const previous = current.bootstrap ?? { status: 'pending' as const, tableProgress: {} };
      current.bootstrap = {
        status: 'failed',
        startedAt: previous.startedAt,
        completedAt: new Date().toISOString(),
        binlogPosition: binlogPosition ?? previous.binlogPosition,
        tableProgress: previous.tableProgress,
        error: message,
      };
      return current;
    });
  }
}

export default BootstrapService;
