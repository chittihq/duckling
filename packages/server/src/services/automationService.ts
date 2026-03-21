import config from '../config';
import logger from '../logger';
import SequentialAppenderService, { type AppenderSyncStats, SyncAlreadyInProgressError } from './sequentialAppenderService';
import DuckDBConnection from '../database/duckdb';
import MySQLConnection from '../database/mysql';
import { DatabaseConfigManager, S3Config } from '../database/databaseConfig';
import s3BackupService from './s3BackupService';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type GuardedSyncResult =
  | { status: 'completed'; stats: AppenderSyncStats }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };

class AutomationService {
  private static instances: Map<string, AutomationService> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private backupInterval?: NodeJS.Timeout;
  private s3BackupInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private syncInterval?: NodeJS.Timeout;
  private databaseId: string;
  private syncService: SequentialAppenderService;
  private duckdb: DuckDBConnection;
  private mysql: MySQLConnection;
  private restartAttempts: number = 0;
  private lastSuccessfulSync: Date = new Date();
  private isRunning: boolean = false;
  private isSyncInProgress: boolean = false;
  private isBackupInProgress: boolean = false;

  /**
   * Resolve DuckDB path for container runtime.
   * Converts relative data/* paths to /app/data/* while preserving absolute paths.
   */
  private resolveDuckdbPath(duckdbPath: string): string {
    return duckdbPath.startsWith('data/') ? `/app/${duckdbPath}` : duckdbPath;
  }

  private getSafeDatabaseId(): string {
    return this.databaseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Build a safe per-database backup directory name to avoid cross-database overwrite.
   */
  private buildBackupDirectoryName(timestamp: string): string {
    return `backup-${this.getSafeDatabaseId()}-${timestamp}`;
  }

  private getBackupDirectoryPattern(): RegExp {
    const escapedDatabaseId = this.getSafeDatabaseId().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^backup-${escapedDatabaseId}-\\d{4}-\\d{2}-\\d{2}T`);
  }

  private getBackupFileName(): string {
    return `duckling-${this.getSafeDatabaseId()}.db`;
  }

  private isLegacyBackupDirectory(name: string): boolean {
    return /^backup-\d{4}-\d{2}-\d{2}$/.test(name);
  }

  private resolveLocalDuckdbPath(): string {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    return dbConfig?.duckdbPath
      ? this.resolveDuckdbPath(dbConfig.duckdbPath)
      : this.resolveDuckdbPath(config.duckdb.path);
  }

  private constructor(
    databaseId: string,
    syncService: SequentialAppenderService,
    duckdb: DuckDBConnection,
    mysql: MySQLConnection
  ) {
    this.databaseId = databaseId;
    this.syncService = syncService;
    this.duckdb = duckdb;
    this.mysql = mysql;
  }

  public static getInstance(
    databaseId: string,
    syncService: SequentialAppenderService,
    duckdb: DuckDBConnection,
    mysql: MySQLConnection
  ): AutomationService {
    if (!AutomationService.instances.has(databaseId)) {
      AutomationService.instances.set(databaseId, new AutomationService(databaseId, syncService, duckdb, mysql));
    }
    return AutomationService.instances.get(databaseId)!;
  }

  public static getExistingInstance(databaseId: string): AutomationService | undefined {
    return AutomationService.instances.get(databaseId);
  }

  /**
   * Check if a sync or backup is currently in progress.
   * Returns null if clear, or a reason string if blocked.
   */
  public getSyncBlockReason(): string | null {
    if (this.isBackupInProgress) return 'backup is currently in progress';
    if (this.isSyncInProgress) return 'another sync is already in progress';
    return null;
  }

  private hasLongRunningMaintenanceInProgress(): boolean {
    return this.isSyncInProgress || this.isBackupInProgress;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private isSyncAlreadyInProgressError(error: unknown): boolean {
    return error instanceof SyncAlreadyInProgressError;
  }

  public static closeInstance(databaseId: string): void {
    const instance = AutomationService.instances.get(databaseId);
    if (instance) {
      instance.stop();
      AutomationService.instances.delete(databaseId);
    }
  }

  /**
   * Start all automation tasks
   * @param syncOffsetMs Optional offset in milliseconds to stagger sync intervals across multiple databases
   */
  public async start(syncOffsetMs: number = 0): Promise<void> {
    if (this.isRunning) {
      logger.warn('Automation service already running');
      return;
    }

    this.isRunning = true;
    logger.info('🤖 Starting automation service...');

    // Start periodic sync with offset to prevent multiple databases syncing simultaneously
    if (config.automation.autoStartSync) {
      await this.startPeriodicSync(syncOffsetMs);
    }

    // Start automatic cleanup
    if (config.automation.autoCleanup) {
      await this.startAutoCleanup();
    }

    // Start automatic backup
    if (config.automation.autoBackup) {
      await this.startAutoBackup();
    }

    // Start independent S3 backup schedule (if configured per-database)
    await this.startAutoS3Backup();

    // Start health monitoring with auto-restart
    if (config.automation.autoRestart) {
      await this.startHealthMonitoring();
    }

    logger.info('✅ Automation service started successfully');
  }

  /**
   * Stop all automation tasks
   */
  public stop(): void {
    logger.info('Stopping automation service...');

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = undefined;
    }

    if (this.s3BackupInterval) {
      clearInterval(this.s3BackupInterval);
      this.s3BackupInterval = undefined;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    this.isRunning = false;
    logger.info('Automation service stopped');
  }

  /**
   * Start periodic incremental sync
   * Respects ENABLE_INCREMENTAL_SYNC configuration flag
   */
  private async startPeriodicSync(offsetMs: number = 0): Promise<void> {
    const intervalMinutes = config.sync.intervalMinutes;
    const syncMode = config.sync.enableIncremental ? 'incremental' : 'full';
    logger.info(`🔄 Periodic sync enabled: Every ${intervalMinutes} minutes (${syncMode} sync)${offsetMs > 0 ? ` with ${offsetMs / 1000}s offset` : ''}`);

    // Run initial sync after delay (5 seconds + offset to stagger databases)
    const initialDelay = 5000 + offsetMs;
    setTimeout(async () => {
      if (config.sync.enableIncremental) {
        await this.performIncrementalSync();
      } else {
        await this.performFullSync();
      }
    }, initialDelay);

    // Schedule periodic sync with the same offset
    const intervalMs = intervalMinutes * 60 * 1000;
    this.syncInterval = setInterval(async () => {
      if (config.sync.enableIncremental) {
        await this.performIncrementalSync();
      } else {
        await this.performFullSync();
      }
    }, intervalMs);
  }

  public async performFullSyncWithStats(): Promise<GuardedSyncResult> {
    const blockReason = this.getSyncBlockReason();
    if (blockReason) {
      logger.warn(`Skipping full sync: ${blockReason}`);
      return { status: 'skipped', reason: blockReason };
    }

    this.isSyncInProgress = true;
    try {
      logger.info('🔄 Running full sync...');
      const stats = await this.syncService.fullSync();

      // Checkpoint after sync to merge WAL into main database file
      // This ensures fast restart and minimal WAL size
      await this.duckdb.checkpoint();

      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;

      logger.info(`✅ Full sync completed: ${stats.successfulTables}/${stats.totalTables} tables, ${stats.totalRecords} records`);
      return { status: 'completed', stats };
    } catch (error) {
      if (this.isSyncAlreadyInProgressError(error)) {
        const reason = 'another sync is already in progress';
        logger.warn(`Skipping full sync: ${reason}`);
        return { status: 'skipped', reason };
      }

      logger.error('Full sync failed:', error);
      return { status: 'failed', error: this.toError(error) };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Perform full sync with overlap guards.
   */
  public async performFullSync(): Promise<'completed' | 'skipped' | false> {
    const result = await this.performFullSyncWithStats();
    if (result.status === 'completed') return 'completed';
    if (result.status === 'skipped') return 'skipped';
    return false;
  }

  /**
   * Perform incremental sync and return detailed result.
   */
  public async performIncrementalSyncWithStats(): Promise<GuardedSyncResult> {
    const blockReason = this.getSyncBlockReason();
    if (blockReason) {
      logger.warn(`Skipping incremental sync: ${blockReason}`);
      return { status: 'skipped', reason: blockReason };
    }

    this.isSyncInProgress = true;
    try {
      logger.info('🔄 Running incremental sync...');
      const stats = await this.syncService.incrementalSync();

      // Checkpoint after sync to merge WAL into main database file
      // This ensures fast restart and minimal WAL size
      await this.duckdb.checkpoint();

      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;

      logger.info(`✅ Incremental sync completed: ${stats.successfulTables}/${stats.totalTables} tables, ${stats.totalRecords} records`);
      return { status: 'completed', stats };
    } catch (error) {
      if (this.isSyncAlreadyInProgressError(error)) {
        const reason = 'another sync is already in progress';
        logger.warn(`Skipping incremental sync: ${reason}`);
        return { status: 'skipped', reason };
      }

      logger.error('Incremental sync failed:', error);
      return { status: 'failed', error: this.toError(error) };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Perform incremental sync
   * Returns 'completed' on success, 'skipped' if guards prevented execution, false on failure.
   */
  public async performIncrementalSync(): Promise<'completed' | 'skipped' | false> {
    const result = await this.performIncrementalSyncWithStats();
    if (result.status === 'completed') return 'completed';
    if (result.status === 'skipped') return 'skipped';
    return false;
  }

  /**
   * Start automatic partition cleanup
   */
  private async startAutoCleanup(): Promise<void> {
    logger.info(`🧹 Auto-cleanup enabled: Every ${config.automation.cleanupIntervalHours}h, retention ${config.automation.retentionDays} days`);

    // Skip immediate cleanup on startup to speed up server initialization
    // First cleanup will run after the scheduled interval
    // await this.performCleanup();

    // Schedule periodic cleanup
    const intervalMs = config.automation.cleanupIntervalHours * 60 * 60 * 1000;
    this.cleanupInterval = setInterval(async () => {
      await this.performCleanup();
    }, intervalMs);
  }

  /**
   * Perform cleanup (Sequential Appender architecture)
   * DuckDB handles storage management automatically
   */
  public async performCleanup(): Promise<void> {
    try {
      logger.info(`🧹 Running automatic cleanup...`);

      // Sequential Appender architecture uses native DuckDB files, not partitions
      // DuckDB handles storage management, VACUUM, and WAL cleanup automatically
      // Future: Could add old backup cleanup, temp file cleanup, etc.

      logger.info('✅ Cleanup completed (Sequential Appender uses native DuckDB storage)');
    } catch (error) {
      logger.error('Automatic cleanup failed:', error);
    }
  }

  /**
   * Start automatic backup
   */
  private async startAutoBackup(): Promise<void> {
    logger.info(`💾 Auto-backup enabled: Every ${config.automation.backupIntervalHours}h, retention ${config.automation.backupRetentionDays} days`);

    // Skip immediate backup on startup to speed up server initialization (especially for large 5GB+ databases)
    // First backup will run after the scheduled interval (24 hours by default)
    // await this.performBackup();

    // Schedule periodic backup
    const intervalMs = config.automation.backupIntervalHours * 60 * 60 * 1000;
    this.backupInterval = setInterval(async () => {
      await this.performBackup();
    }, intervalMs);
  }

  /**
   * Perform backup of critical data
   */
  public async performBackup(): Promise<void> {
    if (this.isSyncInProgress) {
      logger.warn('Skipping automatic backup: sync is currently in progress');
      return;
    }
    if (this.isBackupInProgress) {
      logger.warn('Skipping automatic backup: another backup is already in progress');
      return;
    }

    this.isBackupInProgress = true;
    try {
      logger.info('💾 Running automatic backup...');

      const backupDir = config.paths.backups;
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, this.buildBackupDirectoryName(timestamp));

      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(backupPath, { recursive: true });
      }

      // Backup DuckDB database file (database-specific path for multi-database setups)
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
      const duckdbPath = dbConfig?.duckdbPath
        ? this.resolveDuckdbPath(dbConfig.duckdbPath)
        : this.resolveDuckdbPath(config.duckdb.path);
      if (fs.existsSync(duckdbPath)) {
        // Force WAL checkpoint to create a consistent on-disk snapshot before copying
        await this.duckdb.checkpoint();
        const duckdbBackup = path.join(backupPath, this.getBackupFileName());
        fs.copyFileSync(duckdbPath, duckdbBackup);
        logger.info(`Backed up DuckDB database to ${duckdbBackup}`);
      }

      // Backup metadata directory
      if (fs.existsSync(config.paths.metadata)) {
        const metadataBackup = path.join(backupPath, 'metadata');
        await execAsync(`cp -r "${config.paths.metadata}" "${metadataBackup}"`);
        logger.info(`Backed up metadata to ${metadataBackup}`);
      }

      // Cleanup old backups
      await this.cleanupOldBackups(backupDir);

      logger.info(`✅ Backup completed: ${backupPath}`);

      // Upload to S3 if configured for this database
      if (dbConfig?.s3?.enabled) {
        try {
          const resolvedDuckdbPath = this.resolveDuckdbPath(dbConfig.duckdbPath);
          if (fs.existsSync(resolvedDuckdbPath)) {
            const s3Key = await s3BackupService.uploadBackup(this.databaseId, resolvedDuckdbPath, dbConfig.s3);
            logger.info(`✅ S3 backup uploaded: ${s3Key}`);
          }
        } catch (s3Error) {
          logger.error('S3 upload failed (local backup still succeeded):', s3Error);
        }
      }
    } catch (error) {
      logger.error('Automatic backup failed:', error);
    } finally {
      this.isBackupInProgress = false;
    }
  }

  /**
   * Restore a specific backup from S3
   */
  public async restoreFromS3Backup(backupKey: string): Promise<void> {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    if (!dbConfig?.s3?.enabled) {
      throw new Error('S3 not configured or not enabled for this database');
    }

    const resolvedDuckdbPath = this.resolveDuckdbPath(dbConfig.duckdbPath);

    const tempPath = `${resolvedDuckdbPath}.restore-tmp`;

    try {
      logger.info(`Downloading S3 backup: ${backupKey}`);
      await s3BackupService.downloadBackup(backupKey, tempPath, dbConfig.s3);
      fs.copyFileSync(tempPath, resolvedDuckdbPath);
      fs.unlinkSync(tempPath);
      logger.info('✅ S3 restore completed successfully');
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw error;
    }
  }

  /**
   * Clean up old backup directories
   */
  private async cleanupOldBackups(backupDir: string): Promise<void> {
    try {
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - config.automation.backupRetentionDays);
      const backupPattern = this.getBackupDirectoryPattern();

      const backups = fs.readdirSync(backupDir);

      for (const backup of backups) {
        if (!backupPattern.test(backup)) {
          continue;
        }

        const backupPath = path.join(backupDir, backup);
        const stats = fs.statSync(backupPath);

        if (stats.isDirectory() && stats.mtime < retentionDate) {
          fs.rmSync(backupPath, { recursive: true, force: true });
          logger.info(`Deleted old backup: ${backup}`);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old backups:', error);
    }
  }

  /**
   * Start independent S3 backup schedule (configured per-database via s3BackupIntervalHours)
   */
  private async startAutoS3Backup(): Promise<void> {
    if (this.s3BackupInterval) {
      clearInterval(this.s3BackupInterval);
      this.s3BackupInterval = undefined;
    }

    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    if (!dbConfig?.s3?.enabled || !dbConfig.s3.s3BackupIntervalHours) return;

    const intervalHours = dbConfig.s3.s3BackupIntervalHours;
    const retentionDays = dbConfig.s3.s3BackupRetentionDays ?? 0;
    logger.info(`☁️  S3 auto-backup enabled: Every ${intervalHours}h${retentionDays ? `, ${retentionDays}-day retention` : ''}`);

    this.s3BackupInterval = setInterval(async () => {
      await this.performS3OnlyBackup();
    }, intervalHours * 60 * 60 * 1000);
  }

  /**
   * Upload the current DuckDB file to S3 and clean up old S3 backups.
   * Called on the independent S3 backup schedule (separate from local backup schedule).
   */
  private async performS3OnlyBackup(): Promise<void> {
    try {
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
      if (!dbConfig?.s3?.enabled) return;

      const resolvedDuckdbPath = this.resolveDuckdbPath(dbConfig.duckdbPath);

      if (!fs.existsSync(resolvedDuckdbPath)) {
        logger.warn(`S3 auto-backup: DuckDB file not found at ${resolvedDuckdbPath}`);
        return;
      }

      logger.info(`☁️  Running scheduled S3 backup for database: ${this.databaseId}`);
      const s3Key = await s3BackupService.uploadBackup(this.databaseId, resolvedDuckdbPath, dbConfig.s3);
      logger.info(`✅ Scheduled S3 backup uploaded: ${s3Key}`);

      if (dbConfig.s3.s3BackupRetentionDays) {
        await this.cleanupOldS3Backups(dbConfig.s3);
      }
    } catch (error) {
      logger.error('Scheduled S3 backup failed:', error);
    }
  }

  /**
   * Delete S3 backups older than s3BackupRetentionDays
   */
  private async cleanupOldS3Backups(s3Config: S3Config): Promise<void> {
    try {
      const retentionDays = s3Config.s3BackupRetentionDays!;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);

      const backups = await s3BackupService.listBackups(this.databaseId, s3Config);
      const toDelete = backups.filter(b => b.lastModified < cutoff);

      for (const b of toDelete) {
        await s3BackupService.deleteBackup(b.key, s3Config);
        logger.info(`Deleted old S3 backup: ${b.key}`);
      }

      if (toDelete.length > 0) {
        logger.info(`☁️  S3 cleanup: deleted ${toDelete.length} backup(s) older than ${retentionDays} days`);
      }
    } catch (error) {
      logger.error('S3 backup cleanup failed:', error);
    }
  }

  /**
   * Restart the S3 backup schedule after config changes.
   * Called from the API handler when S3 config is saved.
   */
  public async restartS3BackupSchedule(): Promise<void> {
    await this.startAutoS3Backup();
  }

  /**
   * Restart S3 schedule on an already-running instance (no-op if no instance exists)
   */
  public static async restartS3ScheduleIfRunning(databaseId: string): Promise<void> {
    const instance = AutomationService.instances.get(databaseId);
    if (instance) {
      await instance.restartS3BackupSchedule();
    }
  }

  /**
   * Start health monitoring with auto-restart capability
   */
  private async startHealthMonitoring(): Promise<void> {
    logger.info(`🏥 Auto-restart enabled: Max ${config.automation.maxRestartAttempts} attempts`);

    // Check health every minute
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, 60000);
  }

  /**
   * Perform health check and restart if needed
   */
  private async performHealthCheck(): Promise<void> {
    try {
      if (this.hasLongRunningMaintenanceInProgress()) {
        logger.info('Skipping health check: sync or backup is currently in progress');
        return;
      }

      // Check database connections
      const duckdbHealthy = await this.checkDuckDBHealth();
      const mysqlHealthy = await this.checkMySQLHealth();

      // Check sync service health
      const syncHealthy = await this.checkSyncHealth();

      if (!duckdbHealthy || !mysqlHealthy || !syncHealthy) {
        logger.warn('Health check failed, attempting recovery...');
        await this.attemptRecovery();
      } else {
        // Reset restart attempts on successful health check
        this.restartAttempts = 0;
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      await this.attemptRecovery();
    }
  }

  /**
   * Check DuckDB connection health
   */
  private async checkDuckDBHealth(): Promise<boolean> {
    try {
      await this.duckdb.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('DuckDB health check failed:', error);
      return false;
    }
  }

  /**
   * Check MySQL connection health
   */
  private async checkMySQLHealth(): Promise<boolean> {
    try {
      await this.mysql.testConnection();
      return true;
    } catch (error) {
      logger.error('MySQL health check failed:', error);
      return false;
    }
  }

  /**
   * Check sync service health
   */
  private async checkSyncHealth(): Promise<boolean> {
    try {
      if (this.isSyncInProgress) {
        return true;
      }

      // Check if sync has run in the last 30 minutes
      const timeSinceLastSync = Date.now() - this.lastSuccessfulSync.getTime();
      const maxSyncDelay = 30 * 60 * 1000; // 30 minutes

      if (timeSinceLastSync > maxSyncDelay) {
        logger.warn(`Sync hasn't run in ${Math.floor(timeSinceLastSync / 60000)} minutes`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Sync health check failed:', error);
      return false;
    }
  }

  /**
   * Attempt recovery from failures
   */
  private async attemptRecovery(): Promise<void> {
    const blockReason = this.getSyncBlockReason();
    if (blockReason) {
      logger.info(`Skipping recovery attempt: ${blockReason}`);
      return;
    }

    if (this.restartAttempts >= config.automation.maxRestartAttempts) {
      logger.error(`❌ Max restart attempts (${config.automation.maxRestartAttempts}) reached, manual intervention required`);
      return;
    }

    this.restartAttempts++;
    logger.info(`🔄 Recovery attempt ${this.restartAttempts}/${config.automation.maxRestartAttempts}...`);

    try {
      // Try to test database connections
      logger.info('Testing database connections...');

      const duckdbHealthy = await this.checkDuckDBHealth();
      const mysqlHealthy = await this.checkMySQLHealth();

      if (!duckdbHealthy || !mysqlHealthy) {
        throw new Error('Database connections still unhealthy after reconnect attempt');
      }

      // Try to trigger a sync to verify recovery
      logger.info('Testing sync after recovery...');
      const syncResult = await this.performIncrementalSync();
      if (syncResult === 'skipped') {
        // Another sync or backup is already running — not a failure, just retry later
        logger.info('Recovery sync skipped (another operation in progress), will retry');
        this.restartAttempts--; // Don't count a skip as a failed attempt
        return;
      }
      if (syncResult === false) {
        throw new Error('Recovery sync did not complete successfully');
      }

      logger.info('✅ Recovery successful');
    } catch (error) {
      logger.error(`Recovery attempt ${this.restartAttempts} failed:`, error);

      // Wait before next attempt (exponential backoff)
      const waitTime = Math.min(1000 * Math.pow(2, this.restartAttempts), 60000);
      logger.info(`Waiting ${waitTime / 1000}s before next attempt...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Update last successful sync timestamp
   */
  public recordSuccessfulSync(): void {
    this.lastSuccessfulSync = new Date();
    this.restartAttempts = 0; // Reset on successful sync
  }

  /**
   * Restore from latest backup
   */
  public async restoreFromLatestBackup(): Promise<void> {
    try {
      logger.info('🔄 Attempting restore from latest backup...');

      const backupDir = config.paths.backups;
      if (!fs.existsSync(backupDir)) {
        throw new Error('No backups found');
      }

      // Find latest backup
      const backups = fs.readdirSync(backupDir)
        .filter(name => {
          const backupPath = path.join(backupDir, name);
          if (!fs.statSync(backupPath).isDirectory()) return false;
          if (this.getBackupDirectoryPattern().test(name)) return true;
          return this.databaseId === 'default' && this.isLegacyBackupDirectory(name);
        })
        .sort()
        .reverse();

      if (backups.length === 0) {
        throw new Error('No backup directories found');
      }

      const latestBackup = path.join(backupDir, backups[0]);
      logger.info(`Restoring from backup: ${backups[0]}`);

      // Restore DuckDB database
      const scopedBackup = path.join(latestBackup, this.getBackupFileName());
      const duckdbBackup = fs.existsSync(scopedBackup)
        ? scopedBackup
        : path.join(latestBackup, 'duckling.db'); // backward compatibility
      if (fs.existsSync(duckdbBackup)) {
        fs.copyFileSync(duckdbBackup, this.resolveLocalDuckdbPath());
        logger.info('Restored DuckDB database');
      }

      // Restore metadata
      const metadataBackup = path.join(latestBackup, 'metadata');
      if (fs.existsSync(metadataBackup)) {
        await execAsync(`rm -rf "${config.paths.metadata}" && cp -r "${metadataBackup}" "${config.paths.metadata}"`);
        logger.info('Restored metadata');
      }

      logger.info('✅ Restore completed successfully');
    } catch (error) {
      logger.error('Restore from backup failed:', error);
      throw error;
    }
  }

  /**
   * Get automation status
   */
  public getStatus(): any {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    return {
      isRunning: this.isRunning,
      autoCleanup: {
        enabled: config.automation.autoCleanup,
        intervalHours: config.automation.cleanupIntervalHours,
        retentionDays: config.automation.retentionDays,
      },
      autoBackup: {
        enabled: config.automation.autoBackup,
        intervalHours: config.automation.backupIntervalHours,
        retentionDays: config.automation.backupRetentionDays,
      },
      s3Backup: {
        scheduled: !!this.s3BackupInterval,
        intervalHours: dbConfig?.s3?.s3BackupIntervalHours,
        retentionDays: dbConfig?.s3?.s3BackupRetentionDays,
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
    };
  }
}

export default AutomationService;
