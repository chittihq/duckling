import config from '../config';
import logger from '../logger';
import SequentialAppenderService from './sequentialAppenderService';
import DuckDBConnection from '../database/duckdb';
import MySQLConnection from '../database/mysql';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class AutomationService {
  private static instance: AutomationService;
  private cleanupInterval?: NodeJS.Timeout;
  private backupInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private syncInterval?: NodeJS.Timeout;
  private syncService: SequentialAppenderService;
  private duckdb: DuckDBConnection;
  private mysql: MySQLConnection;
  private restartAttempts: number = 0;
  private lastSuccessfulSync: Date = new Date();
  private isRunning: boolean = false;

  private constructor() {
    this.syncService = SequentialAppenderService.getInstance();
    this.duckdb = DuckDBConnection.getInstance();
    this.mysql = MySQLConnection.getInstance();
  }

  public static getInstance(): AutomationService {
    if (!AutomationService.instance) {
      AutomationService.instance = new AutomationService();
    }
    return AutomationService.instance;
  }

  /**
   * Start all automation tasks
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Automation service already running');
      return;
    }

    this.isRunning = true;
    logger.info('🤖 Starting automation service...');

    // Start periodic sync
    if (config.automation.autoStartSync) {
      await this.startPeriodicSync();
    }

    // Start automatic cleanup
    if (config.automation.autoCleanup) {
      await this.startAutoCleanup();
    }

    // Start automatic backup
    if (config.automation.autoBackup) {
      await this.startAutoBackup();
    }

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
  private async startPeriodicSync(): Promise<void> {
    const intervalMinutes = config.sync.intervalMinutes;
    const syncMode = config.sync.enableIncremental ? 'incremental' : 'full';
    logger.info(`🔄 Periodic sync enabled: Every ${intervalMinutes} minutes (${syncMode} sync)`);

    // Run initial sync after 5 seconds
    setTimeout(async () => {
      if (config.sync.enableIncremental) {
        await this.performIncrementalSync();
      } else {
        await this.performFullSync();
      }
    }, 5000);

    // Schedule periodic sync
    const intervalMs = intervalMinutes * 60 * 1000;
    this.syncInterval = setInterval(async () => {
      if (config.sync.enableIncremental) {
        await this.performIncrementalSync();
      } else {
        await this.performFullSync();
      }
    }, intervalMs);
  }

  /**
   * Perform full sync
   */
  private async performFullSync(): Promise<void> {
    try {
      logger.info('🔄 Running scheduled full sync...');
      const stats = await this.syncService.fullSync();

      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;

      logger.info(`✅ Scheduled full sync completed: ${stats.successfulTables}/${stats.totalTables} tables, ${stats.totalRecords} records`);
    } catch (error) {
      logger.error('Scheduled full sync failed:', error);
    }
  }

  /**
   * Perform incremental sync
   */
  private async performIncrementalSync(): Promise<void> {
    try {
      logger.info('🔄 Running scheduled incremental sync...');
      const stats = await this.syncService.incrementalSync();

      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;

      logger.info(`✅ Scheduled incremental sync completed: ${stats.successfulTables}/${stats.totalTables} tables, ${stats.totalRecords} records`);
    } catch (error) {
      logger.error('Scheduled incremental sync failed:', error);
    }
  }

  /**
   * Start automatic partition cleanup
   */
  private async startAutoCleanup(): Promise<void> {
    logger.info(`🧹 Auto-cleanup enabled: Every ${config.automation.cleanupIntervalHours}h, retention ${config.automation.retentionDays} days`);

    // Run cleanup immediately on startup
    await this.performCleanup();

    // Schedule periodic cleanup
    const intervalMs = config.automation.cleanupIntervalHours * 60 * 60 * 1000;
    this.cleanupInterval = setInterval(async () => {
      await this.performCleanup();
    }, intervalMs);
  }

  /**
   * Perform partition cleanup
   */
  private async performCleanup(): Promise<void> {
    try {
      logger.info(`🧹 Running automatic cleanup (retention: ${config.automation.retentionDays} days)...`);

      const dataPath = path.join(__dirname, '..', '..', 'data');
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - config.automation.retentionDays);

      let totalFilesDeleted = 0;
      let totalSizeFreed = 0;

      // Cleanup facts partitions
      const factsPath = path.join(dataPath, 'facts');
      if (fs.existsSync(factsPath)) {
        const result = await this.cleanupDirectory(factsPath, retentionDate, 'ingest_date');
        totalFilesDeleted += result.filesDeleted;
        totalSizeFreed += result.sizeFreed;
      }

      // Cleanup dimension snapshots
      const dimensionsPath = path.join(dataPath, 'dimensions');
      if (fs.existsSync(dimensionsPath)) {
        const result = await this.cleanupDirectory(dimensionsPath, retentionDate, 'snapshot_date');
        totalFilesDeleted += result.filesDeleted;
        totalSizeFreed += result.sizeFreed;
      }

      logger.info(`✅ Cleanup completed: Deleted ${totalFilesDeleted} files, freed ${(totalSizeFreed / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) {
      logger.error('Automatic cleanup failed:', error);
    }
  }

  /**
   * Clean up directory partitions older than retention date
   */
  private async cleanupDirectory(dirPath: string, retentionDate: Date, partitionKey: string): Promise<{ filesDeleted: number; sizeFreed: number }> {
    let filesDeleted = 0;
    let sizeFreed = 0;

    const tables = fs.readdirSync(dirPath);

    for (const table of tables) {
      const tablePath = path.join(dirPath, table);
      if (!fs.statSync(tablePath).isDirectory()) continue;

      const partitions = fs.readdirSync(tablePath);

      for (const partition of partitions) {
        // Extract date from partition name (e.g., "ingest_date=2024-01-15")
        const match = partition.match(new RegExp(`${partitionKey}=(\\d{4}-\\d{2}-\\d{2})`));
        if (!match) continue;

        const partitionDate = new Date(match[1]);
        if (partitionDate < retentionDate) {
          const partitionPath = path.join(tablePath, partition);

          // Calculate size before deletion
          const files = fs.readdirSync(partitionPath);
          for (const file of files) {
            const filePath = path.join(partitionPath, file);
            const stats = fs.statSync(filePath);
            sizeFreed += stats.size;
            filesDeleted++;
          }

          // Delete partition directory
          fs.rmSync(partitionPath, { recursive: true, force: true });
          logger.debug(`Deleted partition: ${table}/${partition}`);
        }
      }
    }

    return { filesDeleted, sizeFreed };
  }

  /**
   * Start automatic backup
   */
  private async startAutoBackup(): Promise<void> {
    logger.info(`💾 Auto-backup enabled: Every ${config.automation.backupIntervalHours}h, retention ${config.automation.backupRetentionDays} days`);

    // Run backup immediately on startup
    await this.performBackup();

    // Schedule periodic backup
    const intervalMs = config.automation.backupIntervalHours * 60 * 60 * 1000;
    this.backupInterval = setInterval(async () => {
      await this.performBackup();
    }, intervalMs);
  }

  /**
   * Perform backup of critical data
   */
  private async performBackup(): Promise<void> {
    try {
      logger.info('💾 Running automatic backup...');

      const backupDir = path.join(__dirname, '..', '..', 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      const backupPath = path.join(backupDir, `backup-${timestamp}`);

      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(backupPath, { recursive: true });
      }

      // Backup DuckDB database file
      const duckdbPath = config.duckdb.path;
      if (fs.existsSync(duckdbPath)) {
        const duckdbBackup = path.join(backupPath, 'duckling.db');
        fs.copyFileSync(duckdbPath, duckdbBackup);
        logger.info(`Backed up DuckDB database to ${duckdbBackup}`);
      }

      // Backup metadata directory
      const metadataPath = path.join(__dirname, '..', '..', 'data', 'metadata');
      if (fs.existsSync(metadataPath)) {
        const metadataBackup = path.join(backupPath, 'metadata');
        await execAsync(`cp -r "${metadataPath}" "${metadataBackup}"`);
        logger.info(`Backed up metadata to ${metadataBackup}`);
      }

      // Cleanup old backups
      await this.cleanupOldBackups(backupDir);

      logger.info(`✅ Backup completed: ${backupPath}`);
    } catch (error) {
      logger.error('Automatic backup failed:', error);
    }
  }

  /**
   * Clean up old backup directories
   */
  private async cleanupOldBackups(backupDir: string): Promise<void> {
    try {
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - config.automation.backupRetentionDays);

      const backups = fs.readdirSync(backupDir);

      for (const backup of backups) {
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
      await this.syncService.incrementalSync();

      this.lastSuccessfulSync = new Date();
      this.restartAttempts = 0;

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

      const backupDir = path.join(__dirname, '..', '..', 'backups');
      if (!fs.existsSync(backupDir)) {
        throw new Error('No backups found');
      }

      // Find latest backup
      const backups = fs.readdirSync(backupDir)
        .filter(name => fs.statSync(path.join(backupDir, name)).isDirectory())
        .sort()
        .reverse();

      if (backups.length === 0) {
        throw new Error('No backup directories found');
      }

      const latestBackup = path.join(backupDir, backups[0]);
      logger.info(`Restoring from backup: ${backups[0]}`);

      // Restore DuckDB database
      const duckdbBackup = path.join(latestBackup, 'duckling.db');
      if (fs.existsSync(duckdbBackup)) {
        fs.copyFileSync(duckdbBackup, config.duckdb.path);
        logger.info('Restored DuckDB database');
      }

      // Restore metadata
      const metadataBackup = path.join(latestBackup, 'metadata');
      if (fs.existsSync(metadataBackup)) {
        const metadataPath = path.join(__dirname, '..', '..', 'data', 'metadata');
        await execAsync(`rm -rf "${metadataPath}" && cp -r "${metadataBackup}" "${metadataPath}"`);
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
      autoRestart: {
        enabled: config.automation.autoRestart,
        restartAttempts: this.restartAttempts,
        maxAttempts: config.automation.maxRestartAttempts,
        lastSuccessfulSync: this.lastSuccessfulSync,
      },
    };
  }
}

export default AutomationService;
