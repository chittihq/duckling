import config from '../config';
import logger from '../logger';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import ClickHouseSyncService from './clickhouseSyncService';
import { AppenderSyncStats } from './sequentialAppenderService';

export type GuardedSyncResult =
  | { status: 'completed'; stats: AppenderSyncStats }
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

  static getExistingInstance(databaseId: string): ClickHouseAutomationService | undefined {
    return ClickHouseAutomationService.instances.get(databaseId);
  }

  static closeInstance(databaseId: string): void {
    const instance = ClickHouseAutomationService.instances.get(databaseId);
    if (!instance) return;
    instance.stop();
    ClickHouseAutomationService.instances.delete(databaseId);
  }

  static async restartS3ScheduleIfRunning(_databaseId: string): Promise<void> {
    // ClickHouse S3 scheduling is not implemented yet; keep the callsite compatible.
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
        const clickhouseHealthy = await this.clickhouse.testConnection();
        const mysqlHealthy = await this.mysql.testConnection();
        if (!clickhouseHealthy || !mysqlHealthy) {
          this.restartAttempts += 1;
          logger.warn(`ClickHouse automation health check failed for ${this.databaseId}`);
        }
      }, config.monitoring.healthCheckInterval);
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
    logger.info(`ClickHouse cleanup noop for ${this.databaseId}`);
  }

  async performBackup(): Promise<void> {
    throw new Error('ClickHouse backup is not implemented in this migration yet');
  }

  async restoreFromLatestBackup(): Promise<void> {
    throw new Error('ClickHouse restore is not implemented in this migration yet');
  }

  async restoreFromS3Backup(_backupKey: string): Promise<void> {
    throw new Error('ClickHouse S3 restore is not implemented in this migration yet');
  }

  getStatus(): any {
    return {
      isRunning: this.isRunning,
      autoCleanup: {
        enabled: config.automation.autoCleanup,
        intervalHours: config.automation.cleanupIntervalHours,
        retentionDays: config.automation.retentionDays,
      },
      autoBackup: {
        enabled: false,
        intervalHours: null,
        retentionDays: null,
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
