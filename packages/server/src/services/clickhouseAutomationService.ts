import config from '../config';
import logger from '../logger';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import ClickHouseSyncService from './clickhouseSyncService';
import { SyncStats } from './syncTypes';

export type GuardedSyncResult =
  | { status: 'completed'; stats: SyncStats }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };

class ClickHouseAutomationService {
  private static instances: Map<string, ClickHouseAutomationService> = new Map();

  private readonly databaseId: string;
  private readonly syncService: ClickHouseSyncService;
  private readonly clickhouse: ClickHouseConnection;
  private readonly mysql: MySQLConnection;
  private syncInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private isRunning = false;
  private isSyncInProgress = false;
  private restartAttempts = 0;
  private lastSuccessfulSync: Date = new Date();

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
  ): ClickHouseAutomationService {
    if (!ClickHouseAutomationService.instances.has(databaseId)) {
      ClickHouseAutomationService.instances.set(
        databaseId,
        new ClickHouseAutomationService(databaseId, syncService, clickhouse, mysql),
      );
    }
    return ClickHouseAutomationService.instances.get(databaseId)!;
  }

  async start(syncOffsetMs = 0): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (config.automation.autoStartSync) {
      const initialDelay = 5000 + syncOffsetMs;
      setTimeout(async () => {
        if (config.sync.enableIncremental) {
          await this.performIncrementalSync();
        } else {
          await this.performFullSync();
        }
      }, initialDelay);

      this.syncInterval = setInterval(async () => {
        if (config.sync.enableIncremental) {
          await this.performIncrementalSync();
        } else {
          await this.performFullSync();
        }
      }, config.sync.intervalMinutes * 60 * 1000);
    }

    if (config.automation.autoCleanup) {
      this.cleanupInterval = setInterval(async () => {
        await this.performCleanup();
      }, config.automation.cleanupIntervalHours * 60 * 60 * 1000);
    }

    if (config.automation.autoRestart) {
      this.healthCheckInterval = setInterval(async () => {
        await this.runHealthCheck();
      }, config.monitoring.healthCheckInterval);
    }
  }

  private async runHealthCheck(): Promise<void> {
    const [clickhouseHealthy, mysqlHealthy] = await Promise.all([
      this.clickhouse.testConnection(),
      this.mysql.testConnection(),
    ]);

    if (clickhouseHealthy && mysqlHealthy) {
      if (this.restartAttempts > 0) {
        logger.info(`ClickHouse automation recovered for ${this.databaseId} after ${this.restartAttempts} attempt(s)`);
      }
      this.restartAttempts = 0;
      return;
    }

    if (this.restartAttempts >= config.automation.maxRestartAttempts) {
      logger.error(
        `ClickHouse automation health check exhausted ${config.automation.maxRestartAttempts} recovery attempts for ${this.databaseId}; stopping`,
      );
      this.stop();
      return;
    }

    this.restartAttempts += 1;
    const backoffMs = Math.min(60_000, 1_000 * Math.pow(2, this.restartAttempts - 1));
    logger.warn(
      `ClickHouse automation health check failed for ${this.databaseId} ` +
      `(clickhouse=${clickhouseHealthy}, mysql=${mysqlHealthy}, attempt=${this.restartAttempts}); reconnecting in ${backoffMs}ms`,
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      if (!clickhouseHealthy) await this.clickhouse.reconnect();
      if (!mysqlHealthy) await this.mysql.reconnect();
    } catch (error) {
      logger.error(`ClickHouse automation reconnect attempt failed for ${this.databaseId}:`, error);
      return;
    }

    const [chOk, mysqlOk] = await Promise.all([
      this.clickhouse.testConnection(),
      this.mysql.testConnection(),
    ]);

    if (chOk && mysqlOk) {
      logger.info(`ClickHouse automation reconnected ${this.databaseId} successfully`);
      this.restartAttempts = 0;
      if (config.sync.enableIncremental) {
        void this.performIncrementalSync();
      } else {
        void this.performFullSync();
      }
    }
  }

  stop(): void {
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.syncInterval = undefined;
    this.healthCheckInterval = undefined;
    this.cleanupInterval = undefined;
    this.isRunning = false;
  }

  getSyncBlockReason(): string | null {
    if (this.isSyncInProgress) return 'another sync is already in progress';
    return null;
  }

  async performFullSyncWithStats(): Promise<GuardedSyncResult> {
    if (this.isSyncInProgress) {
      return { status: 'skipped', reason: 'another sync is already in progress' };
    }
    this.isSyncInProgress = true;
    try {
      const stats = await this.syncService.fullSync();
      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;
      return { status: 'completed', stats };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  async performIncrementalSyncWithStats(): Promise<GuardedSyncResult> {
    if (this.isSyncInProgress) {
      return { status: 'skipped', reason: 'another sync is already in progress' };
    }
    this.isSyncInProgress = true;
    try {
      const stats = await this.syncService.incrementalSync();
      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;
      return { status: 'completed', stats };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  async performFullSync(): Promise<'completed' | 'skipped' | false> {
    const result = await this.performFullSyncWithStats();
    if (result.status === 'completed') return 'completed';
    if (result.status === 'skipped') return 'skipped';
    return false;
  }

  async performIncrementalSync(): Promise<'completed' | 'skipped' | false> {
    const result = await this.performIncrementalSyncWithStats();
    if (result.status === 'completed') return 'completed';
    if (result.status === 'skipped') return 'skipped';
    return false;
  }

  async performCleanup(): Promise<void> {
    const startedAt = Date.now();
    let optimized = 0;
    let logRowsDeleted = 0;
    try {
      // 1. Compact every raw MergeTree table for this database.
      const objectNames = await this.clickhouse.getAllObjectNames();
      const rawTables = objectNames.filter((name) => name.endsWith('__raw'));
      for (const rawTable of rawTables) {
        try {
          await this.clickhouse.run(`OPTIMIZE TABLE \`${rawTable.replace(/`/g, '``')}\` FINAL`);
          optimized += 1;
        } catch (error) {
          logger.warn(`OPTIMIZE failed for ${rawTable} on ${this.databaseId} (continuing):`, error);
        }
      }

      // 2. Prune sync_log rows older than RETENTION_DAYS.
      // retentionDays is an integer pulled from server config (Math.max(1, ...) below); not user input,
      // so inline interpolation here is safe and avoids parameterized-INTERVAL edge cases in ALTER.
      const retentionDays = Math.max(1, Math.floor(config.automation.retentionDays));
      const beforeRows = await this.clickhouse.execute(
        `SELECT count() AS count FROM sync_log WHERE created_at < now() - INTERVAL ${retentionDays} DAY`,
      );
      const beforeCount = Number((beforeRows[0] as any)?.count || 0);
      if (beforeCount > 0) {
        await this.clickhouse.run(
          `ALTER TABLE sync_log DELETE WHERE created_at < now() - INTERVAL ${retentionDays} DAY`,
        );
        logRowsDeleted = beforeCount;
      }

      logger.info(
        `ClickHouse cleanup for ${this.databaseId}: optimized ${optimized} raw table(s), ` +
        `deleted ${logRowsDeleted} sync_log row(s) older than ${retentionDays} day(s) in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      logger.error(`ClickHouse cleanup failed for ${this.databaseId}:`, error);
    }
  }

  getStatus(): any {
    return {
      isRunning: this.isRunning,
      autoCleanup: {
        enabled: config.automation.autoCleanup,
        intervalHours: config.automation.cleanupIntervalHours,
        retentionDays: config.automation.retentionDays,
      },
      autoRestart: {
        enabled: config.automation.autoRestart,
        restartAttempts: this.restartAttempts,
        maxAttempts: config.automation.maxRestartAttempts,
        lastSuccessfulSync: this.lastSuccessfulSync,
      },
      sync: {
        enabled: config.automation.autoStartSync,
        intervalMinutes: config.sync.intervalMinutes,
      },
      architecture: 'clickhouse',
    };
  }
}

export default ClickHouseAutomationService;
