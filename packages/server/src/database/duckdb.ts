import duckdb from 'duckdb';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import logger from '../logger';

class DuckDBConnection {
  private db: duckdb.Database;
  private static instances: Map<string, DuckDBConnection> = new Map();
  private static initializedInstances: Set<string> = new Set();
  private dbPath: string;
  private initializationPromise: Promise<void> | null = null;
  private isInitializing: boolean = false;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ensureDirectory();
    // Use file-based database for persistent storage
    // Note: Constructor is synchronous but connection may not be ready immediately for large files
    this.db = new duckdb.Database(dbPath);
  }

  /**
   * Wait for database connection to be ready
   * For large database files (>1GB), the connection may not be immediately available
   * Production timeout: 30 retries * 5000ms = 150 seconds (2.5 minutes) max wait
   */
  private async waitForConnection(maxRetries: number = 30, delayMs: number = 5000): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.executeRaw('SELECT 1');
        logger.info(`DuckDB connection established successfully (attempt ${i + 1}/${maxRetries})`);
        return; // Connection is ready
      } catch (error: any) {
        if (error.errorType === 'Connection' && i < maxRetries - 1) {
          logger.warn(`DuckDB connection not ready yet (attempt ${i + 1}/${maxRetries}), waiting ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          logger.error(`DuckDB connection failed after ${maxRetries} retries:`, error);
          throw error; // Re-throw if not a connection error or max retries reached
        }
      }
    }
    throw new Error('DuckDB connection failed to establish after maximum retries');
  }

  static getInstance(databaseId: string = 'default', dbPath?: string): DuckDBConnection {
    if (!DuckDBConnection.instances.has(databaseId)) {
      const path = dbPath || config.duckdb.path;
      const instance = new DuckDBConnection(path);
      DuckDBConnection.instances.set(databaseId, instance);

      // Initialize database asynchronously (don't await here to keep method synchronous)
      if (!DuckDBConnection.initializedInstances.has(databaseId)) {
        instance.initializationPromise = instance.initializeDatabase()
          .then(() => {
            DuckDBConnection.initializedInstances.add(databaseId);
            logger.info(`Database instance '${databaseId}' initialized at ${path}`);
            // Clear the promise after successful initialization
            instance.initializationPromise = null;
          })
          .catch((error) => {
            logger.error(`Failed to initialize database instance '${databaseId}':`, error);
            // Clear the promise even on error to allow retry
            instance.initializationPromise = null;
          });
      }
    }
    return DuckDBConnection.instances.get(databaseId)!;
  }

  static closeInstance(databaseId: string): void {
    const instance = DuckDBConnection.instances.get(databaseId);
    if (instance) {
      instance.close();
      DuckDBConnection.instances.delete(databaseId);
    }
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async ensureInitialized(): Promise<void> {
    // Wait for initialization to complete before allowing queries
    // initializeDatabase() uses Raw methods, so this won't cause deadlock
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  async initializeDatabase(): Promise<void> {
    this.isInitializing = true;
    try {
      // Wait for connection to be ready (especially important for large database files)
      await this.waitForConnection();

      // Create required tables immediately (needed for sync operations)
      // Schema checks and migrations are deferred to background for faster startup

      // Create appender watermarks table (used by SequentialAppenderService)
      // Note: last_processed_id is VARCHAR to support string IDs (e.g., Razorpay: 'pay_XXX', Facebook: 'xxx_yyy')
      await this.runRaw(`
        CREATE TABLE IF NOT EXISTS appender_watermarks (
          table_name VARCHAR PRIMARY KEY,
          last_processed_id VARCHAR,
          last_processed_timestamp TIMESTAMP,
          primary_key_column VARCHAR,
          timestamp_column VARCHAR,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create sync_log table if it does not exist
      await this.runRaw(`
        CREATE TABLE IF NOT EXISTS sync_log (
          id INTEGER PRIMARY KEY,
          table_name VARCHAR,
          sync_type VARCHAR,
          records_processed INTEGER,
          duration_ms INTEGER,
          status VARCHAR,
          error_message TEXT,
          watermark_before TEXT,
          watermark_after TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.runRaw(`
        CREATE SEQUENCE IF NOT EXISTS sync_log_id_seq START 1
      `);

      logger.info('DuckDB database initialized successfully (optimization running in background)');

      // Run non-critical optimizations in background to speed up startup
      this.runOptimizationAsync();
    } catch (error) {
      logger.error('Failed to initialize DuckDB database:', error);
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Run non-critical optimizations in background after initialization
   * This speeds up server startup by deferring WAL config and schema migrations
   */
  private runOptimizationAsync(): void {
    setImmediate(async () => {
      try {
        // Configure WAL settings for optimal performance
        await this.configureWAL();

        // Log WAL size for monitoring
        const walSize = await this.getWALSize();
        if (walSize > 0) {
          logger.info(`Current WAL size: ${(walSize / 1024 / 1024).toFixed(2)} MB`);
        }

        // Check if sync_log exists and what type it is (VIEW or TABLE)
        const syncLogCheck = await this.executeRaw(`
          SELECT table_type FROM information_schema.tables
          WHERE table_schema = 'main' AND table_name = 'sync_log'
        `);

        // Only drop and recreate if it's a VIEW (not a TABLE)
        if (syncLogCheck.length > 0 && syncLogCheck[0].table_type === 'VIEW') {
          await this.runRaw(`DROP VIEW IF EXISTS sync_log`);
          logger.info('Dropped sync_log VIEW (will recreate as TABLE)');
        }

        // Same for sync_metadata
        const syncMetadataCheck = await this.executeRaw(`
          SELECT table_type FROM information_schema.tables
          WHERE table_schema = 'main' AND table_name = 'sync_metadata'
        `);

        if (syncMetadataCheck.length > 0 && syncMetadataCheck[0].table_type === 'VIEW') {
          await this.runRaw(`DROP VIEW IF EXISTS sync_metadata`);
          logger.info('Dropped sync_metadata VIEW (will recreate as TABLE)');
        }

        // Check if appender_watermarks needs schema migration (BIGINT -> VARCHAR for string IDs)
        try {
          const watermarkSchema = await this.executeRaw(`DESCRIBE appender_watermarks`);
          const idColumn = watermarkSchema.find((col: any) => col.column_name === 'last_processed_id');

          if (idColumn && idColumn.column_type.includes('BIGINT')) {
            logger.info('Migrating appender_watermarks table: BIGINT -> VARCHAR for last_processed_id');
            await this.runRaw(`DROP TABLE IF EXISTS appender_watermarks`);
            // Recreate with correct schema
            await this.runRaw(`
              CREATE TABLE IF NOT EXISTS appender_watermarks (
                table_name VARCHAR PRIMARY KEY,
                last_processed_id VARCHAR,
                last_processed_timestamp TIMESTAMP,
                primary_key_column VARCHAR,
                timestamp_column VARCHAR,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
              )
            `);
          }
        } catch (error) {
          // Table doesn't exist or schema check failed, skip migration
          logger.debug('Background schema check skipped:', error);
        }

        logger.info('DuckDB background optimization completed');
      } catch (error) {
        logger.warn('Background optimization failed (non-critical):', error);
      }
    });
  }

  /**
   * Execute query without waiting for initialization (internal use only during initialization)
   */
  private executeRaw(query: string, params?: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (params && params.length > 0) {
        this.db.all(query, ...params, (err: any, rows: any) => {
          if (err) {
            logger.error('DuckDB query error:', { query, params, error: err });
            reject(err);
          } else {
            resolve(rows || []);
          }
        });
      } else {
        this.db.all(query, (err: any, rows: any) => {
          if (err) {
            logger.error('DuckDB query error:', { query, error: err });
            reject(err);
          } else {
            resolve(rows || []);
          }
        });
      }
    });
  }

  async execute(query: string, params?: any[]): Promise<any[]> {
    await this.ensureInitialized();
    return this.executeRaw(query, params);
  }

  /**
   * Run query without waiting for initialization (internal use only during initialization)
   */
  private runRaw(query: string, params?: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (params && params.length > 0) {
        this.db.run(query, ...params, (err: any) => {
          if (err) {
            logger.error('DuckDB run error:', { query, params, error: err });
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        this.db.run(query, (err: any) => {
          if (err) {
            logger.error('DuckDB run error:', { query, error: err });
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  }

  async run(query: string, params?: any[]): Promise<void> {
    await this.ensureInitialized();
    return this.runRaw(query, params);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.execute('SELECT 1');
      return true;
    } catch (error) {
      logger.error('DuckDB connection test failed:', error);
      return false;
    }
  }


  async getTableRowCount(tableName: string): Promise<number> {
    try {
      const result = await this.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
      const count = result[0]?.count || 0;
      return typeof count === 'bigint' ? Number(count) : count;
    } catch (error) {
      // If view doesn't exist yet, return 0
      logger.debug(`Table ${tableName} not found, returning 0 count`);
      return 0;
    }
  }


  async logSync(
    tableName: string,
    syncType: string,
    recordsProcessed: number,
    durationMs: number,
    status: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.run(`
        INSERT INTO sync_log (id, table_name, sync_type, records_processed, duration_ms, status, error_message)
        VALUES (nextval('sync_log_id_seq'), ?, ?, ?, ?, ?, ?)
      `, [tableName, syncType, recordsProcessed, durationMs, status, errorMessage || null]);
    } catch (error) {
      logger.error('Failed to log sync entry:', error);
    }
  }

  async getTables(): Promise<string[]> {
    try {
      const result = await this.execute(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'main'
        AND table_name NOT IN ('appender_watermarks', 'sync_log', 'sync_checkpoint')
        ORDER BY table_name
      `);

      const tables = result.map((row: any) => row.table_name);

      // Filter excluded tables
      return tables.filter(table =>
        !config.sync.excludedTables.includes(table)
      );
    } catch (error) {
      logger.error('Failed to get tables list:', error);
      return [];
    }
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    return this.execute(sql, params);
  }

  /**
   * Force a WAL checkpoint to merge changes into main database file
   * This reduces WAL file size and improves startup performance
   */
  async checkpoint(): Promise<void> {
    try {
      await this.run('CHECKPOINT');
      logger.info('DuckDB checkpoint completed - WAL merged into database file');
    } catch (error) {
      logger.warn('Failed to checkpoint DuckDB:', error);
    }
  }

  /**
   * Configure WAL settings for optimal performance
   * Called during initialization to set up WAL behavior
   */
  async configureWAL(): Promise<void> {
    try {
      // Set checkpoint threshold (checkpoint when WAL reaches this size in MB)
      // Lower value = more frequent checkpoints = smaller WAL files = faster recovery
      await this.run("PRAGMA wal_autocheckpoint='10MB'"); // Checkpoint every 10MB of WAL

      logger.info('DuckDB WAL configuration applied (autocheckpoint: 10MB)');
    } catch (error) {
      logger.warn('Failed to configure WAL settings:', error);
    }
  }

  /**
   * Get WAL file size for monitoring
   */
  async getWALSize(): Promise<number> {
    try {
      const walPath = `${this.dbPath}.wal`;
      if (require('fs').existsSync(walPath)) {
        const stats = require('fs').statSync(walPath);
        return stats.size;
      }
      return 0;
    } catch (error) {
      logger.debug('Could not get WAL size:', error);
      return 0;
    }
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close((err: any) => {
        if (err) {
          logger.error('Error closing DuckDB:', err);
        }
        resolve();
      });
    });
  }

  /**
   * Save sync checkpoint for resumable sync
   */
  async saveCheckpoint(tableName: string, offset: number, batchId: string, totalProcessed: number): Promise<void> {
    const now = new Date();
    try {
      await this.run(`
        INSERT INTO sync_checkpoint (table_name, last_offset, last_batch_id, total_processed, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (table_name) DO UPDATE SET
          last_offset = excluded.last_offset,
          last_batch_id = excluded.last_batch_id,
          total_processed = excluded.total_processed,
          updated_at = excluded.updated_at
      `, [tableName, offset, batchId, totalProcessed, now]);
      logger.debug(`Checkpoint saved for ${tableName}: offset=${offset}, processed=${totalProcessed}`);
    } catch (error) {
      logger.error(`Failed to save checkpoint for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Load sync checkpoint
   */
  async loadCheckpoint(tableName: string): Promise<{ offset: number; batchId: string; totalProcessed: number } | null> {
    try {
      const result = await this.execute(
        'SELECT last_offset, last_batch_id, total_processed FROM sync_checkpoint WHERE table_name = ? AND status = ?',
        [tableName, 'in_progress']
      );

      if (result.length > 0) {
        return {
          offset: result[0].last_offset || 0,
          batchId: result[0].last_batch_id || '',
          totalProcessed: result[0].total_processed || 0
        };
      }
      return null;
    } catch (error) {
      logger.warn(`Failed to load checkpoint for ${tableName}:`, error);
      return null;
    }
  }

  /**
   * Complete sync checkpoint (mark as completed)
   */
  async completeCheckpoint(tableName: string): Promise<void> {
    try {
      await this.run(`
        UPDATE sync_checkpoint
        SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE table_name = ?
      `, [tableName]);
      logger.debug(`Checkpoint completed for ${tableName}`);
    } catch (error) {
      logger.warn(`Failed to complete checkpoint for ${tableName}:`, error);
    }
  }

  /**
   * Clear sync checkpoint
   */
  async clearCheckpoint(tableName: string): Promise<void> {
    try {
      await this.run('DELETE FROM sync_checkpoint WHERE table_name = ?', [tableName]);
      logger.debug(`Checkpoint cleared for ${tableName}`);
    } catch (error) {
      logger.warn(`Failed to clear checkpoint for ${tableName}:`, error);
    }
  }
}

export default DuckDBConnection;