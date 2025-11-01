import duckdb from 'duckdb';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import logger from '../logger';

class DuckDBConnection {
  private db: duckdb.Database;
  private static instance: DuckDBConnection;

  private constructor() {
    this.ensureDirectory();
    // Use file-based database for persistent storage
    this.db = new duckdb.Database(config.duckdb.path);
  }

  static getInstance(): DuckDBConnection {
    if (!DuckDBConnection.instance) {
      DuckDBConnection.instance = new DuckDBConnection();
    }
    return DuckDBConnection.instance;
  }

  private ensureDirectory(): void {
    const dir = path.dirname(config.duckdb.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async initializeDatabase(): Promise<void> {
    try {
      // Check if sync_log exists and what type it is (VIEW or TABLE)
      const syncLogCheck = await this.execute(`
        SELECT table_type FROM information_schema.tables
        WHERE table_schema = 'main' AND table_name = 'sync_log'
      `);

      // Only drop and recreate if it's a VIEW (not a TABLE)
      if (syncLogCheck.length > 0 && syncLogCheck[0].table_type === 'VIEW') {
        await this.run(`DROP VIEW IF EXISTS sync_log`);
        logger.info('Dropped sync_log VIEW (will recreate as TABLE)');
      }

      // Same for sync_metadata
      const syncMetadataCheck = await this.execute(`
        SELECT table_type FROM information_schema.tables
        WHERE table_schema = 'main' AND table_name = 'sync_metadata'
      `);

      if (syncMetadataCheck.length > 0 && syncMetadataCheck[0].table_type === 'VIEW') {
        await this.run(`DROP VIEW IF EXISTS sync_metadata`);
        logger.info('Dropped sync_metadata VIEW (will recreate as TABLE)');
      }

      // Check if appender_watermarks needs schema migration (BIGINT -> VARCHAR for string IDs)
      try {
        const watermarkSchema = await this.execute(`DESCRIBE appender_watermarks`);
        const idColumn = watermarkSchema.find((col: any) => col.column_name === 'last_processed_id');

        if (idColumn && idColumn.column_type.includes('BIGINT')) {
          logger.info('Migrating appender_watermarks table: BIGINT -> VARCHAR for last_processed_id');
          await this.run(`DROP TABLE IF EXISTS appender_watermarks`);
        }
      } catch (error) {
        // Table doesn't exist yet, that's fine
      }

      // Create appender watermarks table (used by SequentialAppenderService)
      // Note: last_processed_id is VARCHAR to support string IDs (e.g., Razorpay: 'pay_XXX', Facebook: 'xxx_yyy')
      await this.run(`
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
      await this.run(`
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

      logger.info('sync_log table ready (preserved existing data if any)');

      await this.run(`
        CREATE SEQUENCE IF NOT EXISTS sync_log_id_seq START 1
      `);

      logger.info('DuckDB database initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize DuckDB database:', error);
      throw error;
    }
  }

  async execute(query: string, params?: any[]): Promise<any[]> {
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

  async run(query: string, params?: any[]): Promise<void> {
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