import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import {
  DatabaseConfig,
  DatabaseConfigManager,
  ReplicationMode,
} from '../database/databaseConfig';
import BootstrapService, { BootstrapOptions, BootstrapResult } from './bootstrapService';
import CdcCompatibilityService from './cdcCompatibilityService';
import BinlogTailerService from './binlogTailerService';
import PeerDBOrchestratorService from './peerdbOrchestratorService';
import ClickHouseSyncService from './clickhouseSyncService';
import { ReplicationCapability, safeDetectReplicationCapability } from './replicationModeDetector';
import logger from '../logger';

export type CoordinatorPhase2Result =
  | { mode: 'peerdb'; mirrors: Array<{ table: string; action: 'create' | 'resume' | 'resync' }> }
  | { mode: 'polling'; status: ReturnType<CdcCompatibilityService['getStatus']> }
  | { mode: 'none'; reason: string };

export type CoordinatorBootstrapAndStartResult = {
  bootstrap: BootstrapResult;
  phase2: CoordinatorPhase2Result;
  effectiveMode: ReplicationMode;
  capability: ReplicationCapability;
};

/**
 * Single orchestration point for the three-phase replication strategy. Callers
 * (HTTP handlers, CLI, scheduled jobs) only ever talk to this — it decides
 * whether to bootstrap, which Phase-2 backend to start, and persists the
 * resulting mode on the database config.
 *
 * See docs/replication-strategy.md for the full design.
 */
class ReplicationCoordinator {
  private readonly databaseId: string;
  private readonly mysql: MySQLConnection;
  private readonly clickhouse: ClickHouseConnection;
  private readonly syncService: ClickHouseSyncService;

  constructor(
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

  /**
   * Phase 1 in isolation. Useful for triggering bootstrap explicitly without
   * starting Phase 2 (e.g. operator wants to inspect the result first).
   */
  async runBootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
    const bootstrap = BootstrapService.getInstance(
      this.databaseId,
      this.mysql,
      this.clickhouse,
      this.syncService,
    );
    return bootstrap.run(options);
  }

  /**
   * Run the capability probe and persist the selected mode on the database
   * config. If the operator pinned `replicationMode` manually, that wins; we
   * still expose the probe result for diagnostics.
   */
  async detectMode(): Promise<{ capability: ReplicationCapability; effectiveMode: ReplicationMode }> {
    const dbConfig = this.requireDatabase();
    const capability = await safeDetectReplicationCapability(this.mysql);

    const pinned = dbConfig.replicationMode;
    const effectiveMode: ReplicationMode = pinned ?? capability.recommendedMode;

    DatabaseConfigManager.getInstance().patchDatabase(this.databaseId, (current) => {
      // Persist the auto-detected mode iff none has been pinned; this lets the
      // UI show "current mode = polling (auto)" without overriding operator intent.
      if (!current.replicationMode) {
        current.replicationMode = capability.recommendedMode;
      }
      return current;
    });

    return { capability, effectiveMode };
  }

  /**
   * The top-level call most surfaces want: load the initial data, then start
   * continuous replication. WHO loads depends on the chosen backend:
   *
   *  - **PeerDB mode**: PeerDB's mirror creation does both the initial snapshot
   *    AND the CDC stream. We attempted to make duckling produce a
   *    PeerDB-compatible destination schema for handoff, but PeerDB v0.36's
   *    ClickHouse destination validator rejects pre-populated tables even
   *    with the full `_peerdb_*` metadata column set. Until upstream PeerDB
   *    supports attach-to-existing-table or honors a per-mirror start
   *    position, we let PeerDB own Phase 1. The capability probe still
   *    records the source binlog position for diagnostics.
   *  - **Polling / none modes**: duckling's DumpService loads into the
   *    `<table>__raw` + projection-view layout the polling path expects,
   *    and records the source binlog position so a future switchover to
   *    PeerDB has the metadata it needs.
   *
   * Idempotent — calling it twice on an already-bootstrapped database
   * re-confirms the mode and resumes mirrors / polling.
   */
  async bootstrapAndStart(options: BootstrapOptions = {}): Promise<CoordinatorBootstrapAndStartResult> {
    const dbConfig = this.requireDatabase();
    const { capability, effectiveMode } = await this.detectMode();

    if (effectiveMode === 'peerdb') {
      // PeerDB owns the data load. Mark bootstrap completed for uniform
      // status across modes; record the source binlog position as
      // diagnostic info (PeerDB tracks its own progress in its catalog).
      const binlogPosition = await this.mysql.captureBinlogPosition();
      DatabaseConfigManager.getInstance().patchDatabase(this.databaseId, (current) => {
        current.bootstrap = {
          status: 'completed',
          completedAt: new Date().toISOString(),
          binlogPosition: binlogPosition
            ? { ...binlogPosition, capturedAt: new Date().toISOString() }
            : undefined,
          tableProgress: current.bootstrap?.tableProgress ?? {},
        };
        return current;
      });
      const bootstrapResult: BootstrapResult = {
        status: 'completed',
        totalTables: 0,
        successfulTables: 0,
        failedTables: 0,
        totalRecords: 0,
        durationMs: 0,
        binlogPosition: binlogPosition
          ? { ...binlogPosition, capturedAt: new Date().toISOString() }
          : null,
        errors: [],
      };
      const phase2 = await this.startPhase2(effectiveMode, dbConfig, bootstrapResult);
      return { bootstrap: bootstrapResult, phase2, effectiveMode, capability };
    }

    // Polling / none modes: duckling owns Phase 1.
    const bootstrapResult = await this.runBootstrap({ ...options, targetMode: 'polling' });

    if (bootstrapResult.status === 'failed') {
      logger.warn(`Skipping Phase 2 start for ${this.databaseId}: bootstrap failed`);
      return {
        bootstrap: bootstrapResult,
        phase2: { mode: 'none', reason: 'bootstrap failed; not starting Phase 2' },
        effectiveMode,
        capability,
      };
    }

    const phase2 = await this.startPhase2(effectiveMode, dbConfig, bootstrapResult);
    return { bootstrap: bootstrapResult, phase2, effectiveMode, capability };
  }

  /**
   * Stop whichever Phase-2 backend is currently active. Safe to call when
   * nothing is running.
   */
  async stopPhase2(): Promise<void> {
    const dbConfig = this.requireDatabase();
    const mode: ReplicationMode = dbConfig.replicationMode ?? 'polling';

    if (mode === 'peerdb') {
      const orchestrator = new PeerDBOrchestratorService(this.databaseId, dbConfig);
      try {
        const tables = await this.mysql.getTables();
        for (const table of tables) {
          await orchestrator.pauseMirror(table).catch((error) => {
            logger.warn(`Failed to pause PeerDB mirror for ${table}`, { error });
          });
        }
      } catch (error) {
        logger.warn(`stopPhase2 (peerdb) failed for ${this.databaseId}`, { error });
      }
      return;
    }

    if (mode === 'polling') {
      const cdc = CdcCompatibilityService.getInstance(
        this.databaseId,
        this.syncService,
        this.clickhouse,
        this.mysql,
      );
      await cdc.stop();
      await BinlogTailerService.closeInstance(this.databaseId);
    }
  }

  private async startPhase2(
    mode: ReplicationMode,
    dbConfig: DatabaseConfig,
    bootstrapResult: BootstrapResult,
  ): Promise<CoordinatorPhase2Result> {
    if (mode === 'none') {
      return { mode: 'none', reason: 'replicationMode = none; bootstrap only' };
    }

    if (mode === 'peerdb') {
      const orchestrator = new PeerDBOrchestratorService(this.databaseId, dbConfig);
      const tables = await this.mysql.getTables();
      const mirrors: Array<{ table: string; action: 'create' | 'resume' | 'resync' }> = [];

      // PeerDB v0.36 rejects pre-populated destination tables, so we drop any
      // polling-path leftovers and let PeerDB create + populate its own tables
      // via doInitialSnapshot: true. The bootstrap.binlogPosition we recorded
      // earlier is informational only (until PeerDB supports per-mirror
      // start positions upstream).
      for (const tableName of tables) {
        try {
          await this.clickhouse.dropView(tableName);
          await this.clickhouse.dropTable(tableName);
          await this.clickhouse.dropTable(`${tableName}__raw`);
        } catch (error) {
          logger.warn(`Pre-mirror cleanup failed for ${tableName} (continuing)`, { error });
        }

        const existing = await orchestrator.getMirrorStatus(tableName);
        if (existing) {
          await orchestrator.resumeMirror(tableName);
          mirrors.push({ table: tableName, action: 'resume' });
          continue;
        }
        await orchestrator.createMirror(tableName, { doInitialSnapshot: true });
        mirrors.push({ table: tableName, action: 'create' });
      }
      return { mode: 'peerdb', mirrors };
    }

    // mode === 'polling'
    const cdc = CdcCompatibilityService.getInstance(
      this.databaseId,
      this.syncService,
      this.clickhouse,
      this.mysql,
    );
    const status = await cdc.start();
    await this.maybeStartCdcLite(bootstrapResult);
    return { mode: 'polling', status };
  }

  /**
   * CDC-lite: best-effort binlog tailer that augments polling (delete
   * tombstones + immediate sync nudges). Purely capability-driven PER
   * DATABASE — no flag. The replication ladder is:
   *
   *   full CDC capability (ROW + FULL image + FULL metadata + grants) → peerdb
   *   partial capability  (ROW binlogs + grants)                      → polling + CDC-lite
   *   no binlog capability                                            → pure polling
   *
   * Works with binlog_row_metadata=MINIMAL, i.e. on sources that fail the
   * full PeerDB probe. Any failure here (or at runtime) leaves pure polling
   * running, which is the pre-CDC-lite behavior.
   */
  private async maybeStartCdcLite(_bootstrapResult: BootstrapResult): Promise<void> {
    try {
      const capability = await safeDetectReplicationCapability(this.mysql);
      const { log_bin, binlog_format } = capability.variables;
      const isOn = (v: string | null | undefined): boolean => v != null && /^(ON|1)$/i.test(String(v).trim());
      const grants = capability.grants.join(' ').toUpperCase();
      const hasGrants = grants.includes('REPLICATION SLAVE') && grants.includes('REPLICATION CLIENT');
      if (!isOn(log_bin) || String(binlog_format).toUpperCase() !== 'ROW' || !hasGrants) {
        logger.info(
          `CDC-lite unavailable for ${this.databaseId} ` +
          `(log_bin=${log_bin}, binlog_format=${binlog_format}, replication grants=${hasGrants}); pure polling only`,
        );
        return;
      }
      const tailer = BinlogTailerService.getInstance(
        this.databaseId,
        this.mysql,
        this.clickhouse,
        this.syncService,
      );
      await tailer.start();
    } catch (error) {
      logger.warn(`CDC-lite failed to start for ${this.databaseId}; pure polling only:`, error);
    }
  }

  private requireDatabase(): DatabaseConfig {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    if (!dbConfig) {
      throw new Error(`Unknown database '${this.databaseId}'`);
    }
    return dbConfig;
  }
}

export default ReplicationCoordinator;
