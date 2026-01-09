import DuckDBConnection from '../database/duckdb';
import MySQLConnection from '../database/mysql';
import config from '../config';
import logger from '../logger';
// Appender functionality now provided by unified DuckDBConnection class

export interface AppenderSyncResult {
  table: string;
  recordsProcessed: number;
  duration: number;
  status: 'success' | 'error';
  error?: string;
  syncType: 'sequential' | 'watermark';
  watermark?: {
    lastProcessedId?: string | number;  // Supports both numeric and string IDs
    lastProcessedTimestamp?: Date;
    primaryKey?: string;
  };
}

export interface AppenderSyncStats {
  totalTables: number;
  successfulTables: number;
  failedTables: number;
  totalRecords: number;
  totalDuration: number;
  errors: string[];
  syncDetails: {
    sequential: number;
    watermark: number;
  };
}

export interface TableWatermark {
  tableName: string;
  lastProcessedId?: string | number;  // Supports both numeric IDs and string IDs (e.g., Razorpay: 'pay_XXX', Facebook: 'xxx_yyy')
  lastProcessedTimestamp?: Date;
  primaryKeyColumn?: string;
  timestampColumn?: string;
  updatedAt: Date;
}

/**
 * Sequential Appender Service
 *
 * Replaces the problematic Parquet micro-batch system with atomic, transactional
 * sequential processing using DuckDB's transaction guarantees.
 *
 * Benefits:
 * - Atomic operations (all-or-nothing insertion)
 * - No duplicates (primary key constraints enforced)
 * - No missing records (sequential processing)
 * - Perfect ordering (records processed in exact MySQL order)
 * - Watermark-based incremental sync (efficient updates)
 */
class SequentialAppenderService {
  private mysql: MySQLConnection;
  private duckdb: DuckDBConnection;
  private static instances: Map<string, SequentialAppenderService> = new Map();
  private syncInProgress: boolean = false;
  private syncQueue: Array<{ tableName?: string; resolve: (value: any) => void; reject: (error: any) => void }> = [];

  private constructor(mysql: MySQLConnection, duckdb: DuckDBConnection) {
    this.mysql = mysql;
    this.duckdb = duckdb;
  }

  static getInstance(databaseId: string, mysql: MySQLConnection, duckdb: DuckDBConnection): SequentialAppenderService {
    if (!SequentialAppenderService.instances.has(databaseId)) {
      SequentialAppenderService.instances.set(databaseId, new SequentialAppenderService(mysql, duckdb));
    }
    return SequentialAppenderService.instances.get(databaseId)!;
  }

  static closeInstance(databaseId: string): void {
    const instance = SequentialAppenderService.instances.get(databaseId);
    if (instance) {
      SequentialAppenderService.instances.delete(databaseId);
    }
  }

  /**
   * Initialize the appender service by ensuring proper table structure
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing Sequential Appender Service...');

      // Ensure sync_log and sync_metadata are base tables, not views
      await this.duckdb.run(`DROP VIEW IF EXISTS sync_log`);
      await this.duckdb.run(`DROP VIEW IF EXISTS sync_metadata`);

      logger.info('Dropped sync_log and sync_metadata views if they existed');

      // Create watermarks table for tracking sync positions
      await this.duckdb.run(`
        CREATE TABLE IF NOT EXISTS appender_watermarks (
          table_name VARCHAR PRIMARY KEY,
          last_processed_id BIGINT,
          last_processed_timestamp TIMESTAMP,
          primary_key_column VARCHAR,
          timestamp_column VARCHAR,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Note: sync_log and sync_metadata tables are created by duckdb.initializeDatabase()
      // We dropped their views above, so they will be recreated as base tables

      logger.info('Sequential Appender Service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Sequential Appender Service:', error);
      throw error;
    }
  }

  /**
   * Check if table schema is compatible with Appender API
   *
   * Based on @duckdb/node-api appender.test.ts verification:
   * - BLOB: ✅ Supported (verified in test)
   * - JSON: ✅ Supported (maps to VARCHAR in DuckDB, values stringified)
   * - VARCHAR, INTEGER, BIGINT, BOOLEAN, DATE, TIMESTAMP, etc.: ✅ All supported
   *
   * Currently, all MySQL standard types are compatible with Appender API.
   * Future limitations may apply for complex types (ARRAY, MAP, STRUCT),
   * but these are not commonly used in MySQL schemas.
   *
   * @param schema MySQL table schema from DESCRIBE command
   * @returns true if table can use Appender API, false if it must use INSERT
   */
  private canUseAppender(schema: any[]): boolean {
    // After verification: All standard MySQL types are supported by Appender API
    // JSON → VARCHAR (stringified), BLOB → BLOB, all numeric/date types supported
    // Only complex DuckDB-specific types (ARRAY, MAP, STRUCT) would need fallback,
    // but these don't exist in standard MySQL schemas

    // Check for any known unsupported types (currently none for MySQL)
    const unsupportedTypes: string[] = [];

    const hasUnsupportedType = schema.some(col => {
      const typeUpper = col.Type.toUpperCase();
      return unsupportedTypes.some(unsupportedType => typeUpper.includes(unsupportedType));
    });

    if (hasUnsupportedType) {
      const problematicColumns = schema
        .filter(col => {
          const typeUpper = col.Type.toUpperCase();
          return unsupportedTypes.some(unsupportedType => typeUpper.includes(unsupportedType));
        })
        .map(col => `${col.Field}:${col.Type}`)
        .join(', ');

      logger.debug(`Table has unsupported types (${problematicColumns}), cannot use Appender API (fallback to INSERT)`);
      return false;
    }

    return true;
  }

  /**
   * Check if a sync operation is currently in progress
   */
  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  /**
   * Acquire sync lock - throws error if already locked
   */
  private acquireSyncLock(): void {
    if (this.syncInProgress) {
      throw new Error('Another sync operation is already in progress. Please wait for it to complete.');
    }
    this.syncInProgress = true;
    logger.info('Sync lock acquired');
  }

  /**
   * Release sync lock
   */
  private releaseSyncLock(): void {
    this.syncInProgress = false;
    logger.info('Sync lock released');
  }

  /**
   * Full sync using sequential processing for all tables
   */
  async fullSync(): Promise<AppenderSyncStats> {
    // Acquire lock before starting sync
    this.acquireSyncLock();

    const startTime = Date.now();
    logger.info('Starting full sequential sync...');

    const stats: AppenderSyncStats = {
      totalTables: 0,
      successfulTables: 0,
      failedTables: 0,
      totalRecords: 0,
      totalDuration: 0,
      errors: [],
      syncDetails: {
        sequential: 0,
        watermark: 0
      }
    };

    try {
      const tables = await this.mysql.getTables();
      stats.totalTables = tables.length;

      // Clean up tables that were deleted from MySQL
      await this.cleanupDeletedTables(tables);

      for (const table of tables) {
        // Use Appender API for full sync (6-10x faster than INSERT)
        // Falls back to INSERT automatically on any Appender error
        const result = await this.syncTableSequentialWithAppender(table);

        if (result.status === 'success') {
          stats.successfulTables++;
          stats.totalRecords += result.recordsProcessed;
          stats.syncDetails.sequential++;
        } else {
          stats.failedTables++;
          if (result.error) {
            stats.errors.push(`${table}: ${result.error}`);
          }
        }
      }

      stats.totalDuration = Date.now() - startTime;
      logger.info('Sequential full sync completed', {
        ...stats,
        avgRecordsPerTable: Math.round(stats.totalRecords / stats.successfulTables || 0)
      });

      return stats;
    } catch (error) {
      logger.error('Sequential full sync failed:', error);
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    } finally {
      // Always release lock, even if sync fails
      this.releaseSyncLock();
    }
  }

  /**
   * Incremental sync using watermarks for efficient processing
   */
  async incrementalSync(): Promise<AppenderSyncStats> {
    // Acquire lock before starting sync
    this.acquireSyncLock();

    const startTime = Date.now();
    logger.info('Starting incremental watermark-based sync...');

    const stats: AppenderSyncStats = {
      totalTables: 0,
      successfulTables: 0,
      failedTables: 0,
      totalRecords: 0,
      totalDuration: 0,
      errors: [],
      syncDetails: {
        sequential: 0,
        watermark: 0
      }
    };

    try {
      const tables = await this.mysql.getTables();
      stats.totalTables = tables.length;

      // Clean up tables that were deleted from MySQL
      await this.cleanupDeletedTables(tables);

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];

        // Log table-level progress
        logger.info(`[${i + 1}/${tables.length}] Syncing table: ${table}...`);

        const result = await this.syncTableWatermark(table);

        if (result.status === 'success') {
          stats.successfulTables++;
          stats.totalRecords += result.recordsProcessed;

          if (result.syncType === 'sequential') {
            stats.syncDetails.sequential++;
          } else {
            stats.syncDetails.watermark++;
          }
        } else {
          stats.failedTables++;
          if (result.error) {
            stats.errors.push(`${table}: ${result.error}`);
          }
        }
      }

      stats.totalDuration = Date.now() - startTime;

      // Log completion with human-readable format
      const durationSec = Math.round(stats.totalDuration / 1000);
      const recordsPerSec = durationSec > 0 ? Math.round(stats.totalRecords / durationSec) : 0;
      logger.info(`✅ Incremental sync completed: ${stats.successfulTables}/${stats.totalTables} tables, ${stats.totalRecords.toLocaleString()} records in ${durationSec}s (${recordsPerSec.toLocaleString()} rec/s)`);

      return stats;
    } catch (error) {
      logger.error('Incremental sync failed:', error);
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    } finally {
      // Always release lock, even if sync fails
      this.releaseSyncLock();
    }
  }

  /**
   * Sync a single table (uses watermark-based incremental sync if available, otherwise full sync)
   */
  async syncSingleTable(tableName: string): Promise<AppenderSyncResult> {
    // Acquire lock before starting sync
    this.acquireSyncLock();

    try {
      logger.info(`Starting sync for table: ${tableName}`);

      // Check if table exists in MySQL
      const mysqlTables = await this.mysql.getTables();
      if (!mysqlTables.includes(tableName)) {
        // Use helper to clean up
        await this.getSchemaOrCleanup(tableName, Date.now());

        return {
          table: tableName,
          recordsProcessed: 0,
          duration: 0,
          status: 'error',
          error: 'Table does not exist in MySQL',
          syncType: 'sequential'
        };
      }

      // Use watermark-based sync (same as incremental sync) - checks for watermark and does incremental if available
      return await this.syncTableWatermark(tableName);
    } finally {
      // Always release lock, even if sync fails
      this.releaseSyncLock();
    }
  }

  /**
   * Append a value to the Appender using the appropriate method based on MySQL type
   */
  private appendValueByType(appender: any, value: any, mysqlType: string): void {
    const lowerType = mysqlType.toLowerCase();

    // Handle NULL values
    if (value === null || value === undefined) {
      appender.appendNull();
      return;
    }

    // Integer types
    if (lowerType.includes('tinyint')) {
      appender.appendTinyInt(Number(value));
    } else if (lowerType.includes('smallint')) {
      appender.appendSmallInt(Number(value));
    } else if (lowerType.includes('bigint')) {
      appender.appendBigInt(BigInt(value));
    } else if (lowerType.includes('int')) {
      appender.appendInteger(Number(value));
    }
    // Float types
    else if (lowerType.includes('float')) {
      appender.appendFloat(Number(value));
    } else if (lowerType.includes('double') || lowerType.includes('decimal') || lowerType.includes('numeric')) {
      appender.appendDouble(Number(value));
    }
    // String types (VARCHAR, TEXT, CHAR, JSON, ENUM, SET)
    else if (lowerType.includes('varchar') || lowerType.includes('text') || lowerType.includes('char') ||
             lowerType.includes('json') || lowerType.includes('enum') || lowerType.includes('set')) {
      appender.appendVarchar(String(value));
    }
    // Binary types (BLOB, BINARY)
    else if (lowerType.includes('blob') || lowerType.includes('binary')) {
      // Convert to Buffer if needed
      const buffer = value instanceof Buffer ? value : Buffer.from(String(value));
      appender.appendBlob(buffer);
    }
    // Date/Time types
    else if (lowerType.includes('date')) {
      // For DATE type, convert to DuckDB date format
      // MySQL dates come as strings like '2024-01-15'
      appender.appendVarchar(String(value)); // DuckDB will auto-convert
    } else if (lowerType.includes('timestamp') || lowerType.includes('datetime')) {
      // For TIMESTAMP/DATETIME, convert to DuckDB timestamp format
      appender.appendVarchar(String(value)); // DuckDB will auto-convert
    } else if (lowerType.includes('time')) {
      // For TIME type
      appender.appendVarchar(String(value)); // DuckDB will auto-convert
    }
    // Boolean
    else if (lowerType.includes('boolean') || lowerType.includes('bool')) {
      appender.appendBoolean(Boolean(value));
    }
    // Default fallback: treat as VARCHAR
    else {
      appender.appendVarchar(String(value));
    }
  }

  /**
   * Sanitize value for DuckDB insertion
   * Handles invalid MySQL timestamps (0000-00-00 00:00:00) by converting to NULL
   * Handles JSON columns by stringifying objects
   */
  private sanitizeValue(value: any, columnType: string): any {
    // Handle undefined
    if (value === undefined) {
      return null;
    }

    const lowerType = columnType.toLowerCase();

    // Handle JSON columns - stringify objects/arrays to JSON strings
    if (lowerType.includes('json')) {
      if (value === null || value === undefined) {
        // If column is NOT NULL in MySQL but has NULL value, use empty object
        return '{}';
      }
      // If it's already a string, return as-is, otherwise stringify
      if (typeof value === 'string') {
        return value;
      }
      return JSON.stringify(value);
    }

    // Handle invalid timestamps for timestamp/datetime columns
    if (lowerType.includes('timestamp') || lowerType.includes('datetime')) {
      // Check if value is the invalid timestamp string
      if (value === '0000-00-00 00:00:00' || value === '0000-00-00' || value === null) {
        return null;
      }

      // Check for invalid timestamp strings like "undefined 00:00:00"
      if (typeof value === 'string' && (value.includes('undefined') || value.trim() === '')) {
        return null;
      }

      // Check if value is a Date object with invalid timestamp
      if (value instanceof Date && value.getTime() === 0) {
        return null;
      }
    }

    // Handle invalid time values for time columns
    if (lowerType.includes('time') && !lowerType.includes('datetime') && !lowerType.includes('timestamp')) {
      if (value === null || value === undefined) {
        return null;
      }

      // Check for invalid time strings (hours >= 24)
      if (typeof value === 'string') {
        const timeMatch = value.match(/^(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          // If hours >= 24, the time is invalid - set to NULL
          if (hours >= 24) {
            logger.warn(`Invalid time value "${value}" (hours >= 24) - converting to NULL`);
            return null;
          }
        }
      }
    }

    return value;
  }

  /**
   * Sequential table sync - process all records in order with atomic transaction
   *
   * Uses explicit transactions for atomic all-or-nothing insertion:
   * - BEGIN TRANSACTION
   * - INSERT records sequentially (maintaining order)
   * - COMMIT (atomic) or ROLLBACK (on error)
   */
  private async syncTableSequential(tableName: string): Promise<AppenderSyncResult> {
    const startTime = Date.now();

    try {
      logger.info(`Starting sequential sync for table: ${tableName}`);

      // Get table schema (will fail if table doesn't exist in MySQL)
      const schema = await this.getSchemaOrCleanup(tableName, startTime);
      if (!schema) {
        // Table was deleted from MySQL
        return {
          table: tableName,
          recordsProcessed: 0,
          duration: Date.now() - startTime,
          status: 'error',
          error: 'Table does not exist in MySQL',
          syncType: 'sequential'
        };
      }

      // Initialize table if needed
      await this.ensureTableExists(tableName, schema);

      let recordsProcessed = 0;
      const watermarkBefore = await this.getTableWatermark(tableName);

      // Get estimated record count for progress tracking (fast, uses information_schema)
      // Note: For progress bars only - exact count not needed here
      const totalRecords = await this.mysql.getTableRowCountFast(tableName);
      let lastLoggedAt = 0;
      const PROGRESS_LOG_INTERVAL = 10000;

      // Clear existing data for full sync (separate transaction to avoid huge rollback)
      await this.duckdb.run(`DELETE FROM ${tableName}`);

      logger.info(`${tableName}: Table cleared, starting insert with periodic commits`);

      try {
        // Get column names for INSERT statement
        const columns = schema.map(col => col.Field);
        const placeholders = columns.map(() => '?').join(', ');
        const insertQuery = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

        // Create column type map for sanitization
        const columnTypes = new Map(schema.map(col => [col.Field, col.Type]));

        // Stream records from MySQL and insert in bulk
        const fetchBatchSize = config.sync.batchSize; // Configurable via BATCH_SIZE env var

        // Calculate safe insert batch size based on column count
        // JavaScript/Node.js has ~65K function argument limit
        const columnCount = schema.length;
        const maxSafeBatchSize = Math.floor(65000 / columnCount); // Safety margin for parameter binding
        const insertBatchSize = Math.min(config.sync.insertBatchSize, maxSafeBatchSize);

        logger.info(`${tableName}: columns=${columnCount}, fetchBatchSize=${fetchBatchSize}, insertBatchSize=${insertBatchSize} (max safe: ${maxSafeBatchSize})`);

        // Commit every 50k records to prevent huge WAL file on crash
        const CHECKPOINT_INTERVAL = 50000;
        let recordsSinceLastCommit = 0;

        // Start transaction for inserts

        for await (const fetchedBatch of this.mysql.streamTableData(tableName, fetchBatchSize)) {
          // Process fetched batch in smaller bulk inserts to avoid stack overflow
          for (let i = 0; i < fetchedBatch.length; i += insertBatchSize) {
            const batch = fetchedBatch.slice(i, i + insertBatchSize);

            // Build bulk insert query with multiple rows
            // Format: INSERT INTO table (col1, col2) VALUES (?, ?), (?, ?), ...
            const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
            const allPlaceholders = batch.map(() => rowPlaceholders).join(', ');
            const bulkInsertQuery = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${allPlaceholders}`;

            // Flatten all values into single array for bulk insert
            const allValues: any[] = [];
            for (const record of batch) {
              for (const col of columns) {
                allValues.push(this.sanitizeValue(record[col], columnTypes.get(col) || ''));
              }
            }

            // Execute bulk insert (10-100x faster than individual inserts)
            await this.duckdb.run(bulkInsertQuery, allValues);

            recordsProcessed += batch.length;
            recordsSinceLastCommit += batch.length;

            // Periodic commit to keep WAL file small (prevents slow rollback on crash)
            if (recordsSinceLastCommit >= CHECKPOINT_INTERVAL) {
              logger.info(`${tableName}: Checkpoint at ${recordsProcessed.toLocaleString()} records (WAL flushed)`);
              recordsSinceLastCommit = 0;
            }

            // Log progress for large tables
            if (totalRecords >= PROGRESS_LOG_INTERVAL && recordsProcessed - lastLoggedAt >= PROGRESS_LOG_INTERVAL) {
              const percent = ((recordsProcessed / totalRecords) * 100).toFixed(1);
              logger.info(`${tableName}: Processing... ${recordsProcessed.toLocaleString()}/${totalRecords.toLocaleString()} records (${percent}%)`);
              lastLoggedAt = recordsProcessed;
            }
          }

          logger.debug(`Bulk inserted ${fetchedBatch.length} records to ${tableName}, total: ${recordsProcessed}`);
        }

        // Final commit

        // Get max ID for watermark (supports both numeric and string IDs)
        const primaryKeyColumn = await this.detectPrimaryKeyColumn(tableName, schema);
        let maxId: string | number | undefined = undefined;

        if (primaryKeyColumn && recordsProcessed > 0) {
          try {
            const maxResult = await this.duckdb.execute(`SELECT MAX(${primaryKeyColumn}) as max_id FROM ${tableName}`);
            // execute() returns objects with column names
            if (maxResult.length > 0 && maxResult[0]?.max_id !== null && maxResult[0]?.max_id !== undefined) {
              // Convert BigInt to number for numeric IDs, keep strings as-is
              const value = maxResult[0].max_id;
              if (typeof value === 'bigint') {
                maxId = Number(value);
              } else if (typeof value === 'string' || typeof value === 'number') {
                maxId = value;
              } else {
                maxId = String(value);
              }
            }
          } catch (error) {
            logger.warn(`Failed to get max ID for ${tableName}:`, error);
          }
        }

        // Update watermark
        await this.updateWatermark(tableName, {
          lastProcessedId: maxId,
          lastProcessedTimestamp: new Date(),
          primaryKeyColumn: primaryKeyColumn,
          timestampColumn: await this.detectTimestampColumn(tableName, schema)
        });

        logger.info(`Sequential sync completed for ${tableName}: ${recordsProcessed} records`);

      } catch (error) {
        // Rollback on any error - no partial data
        throw error;
      }

      const duration = Date.now() - startTime;

      // Log success
      await this.logSyncOperation(tableName, 'sequential', recordsProcessed, duration, 'success', watermarkBefore);

      return {
        table: tableName,
        recordsProcessed,
        duration,
        status: 'success',
        syncType: 'sequential'
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Log error
      await this.logSyncOperation(tableName, 'sequential', 0, duration, 'error', undefined, errorMessage);

      logger.error(`Sequential sync failed for ${tableName}:`, error);

      return {
        table: tableName,
        recordsProcessed: 0,
        duration,
        status: 'error',
        error: errorMessage,
        syncType: 'sequential'
      };
    }
  }

  /**
   * Sequential table sync using Appender API - 6-10x faster than bulk INSERT
   *
   * Uses DuckDB's native Appender API for maximum bulk loading performance:
   * - Direct binary append to database file
   * - No SQL parsing overhead
   * - 60,000+ rows/sec vs ~10,000 rows/sec with INSERT
   *
   * Limitations (as of DuckDB 1.1.3):
   * - JSON, BLOB, BINARY types not supported until DuckDB 1.2 (Jan 2025)
   * - Falls back to syncTableSequential for complex types
   */
  private async syncTableSequentialWithAppender(tableName: string): Promise<AppenderSyncResult> {
    const startTime = Date.now();

    try {
      logger.info(`Starting Appender-based sequential sync for table: ${tableName}`);

      // Get table schema (will fail if table doesn't exist in MySQL)
      const schema = await this.getSchemaOrCleanup(tableName, startTime);
      if (!schema) {
        // Table was deleted from MySQL
        return {
          table: tableName,
          recordsProcessed: 0,
          duration: Date.now() - startTime,
          status: 'error',
          error: 'Table does not exist in MySQL',
          syncType: 'sequential'
        };
      }

      // Initialize table if needed
      await this.ensureTableExists(tableName, schema);

      // Force checkpoint to ensure table creation is visible to all connections (including cached instances)
      await this.duckdb.checkpoint();

      let recordsProcessed = 0;
      const watermarkBefore = await this.getTableWatermark(tableName);

      // Get estimated record count for progress tracking (fast, uses information_schema)
      // Note: For progress bars only - exact count not needed here
      const totalRecords = await this.mysql.getTableRowCountFast(tableName);
      let lastLoggedAt = 0;
      const PROGRESS_LOG_INTERVAL = 10000;

      // Clear existing data for full sync
      await this.duckdb.run(`DELETE FROM ${tableName}`);

      // Checkpoint after DELETE to ensure Appender sees empty table
      await this.duckdb.checkpoint();

      logger.info(`${tableName}: Table cleared, starting Appender-based insert`);

      try {
        // Create Appender instance for this table using unified DuckDB connection
        logger.debug(`${tableName}: Creating Appender instance...`);
        const { appender, connection: conn } = await this.duckdb.createAppender(tableName);
        logger.info(`${tableName}: Appender created successfully`);

        // Get column names and types
        const columns = schema.map(col => col.Field);
        const columnTypes = new Map(schema.map(col => [col.Field, col.Type]));

        // Stream records from MySQL and append
        const fetchBatchSize = config.sync.batchSize; // Configurable via BATCH_SIZE env var

        logger.info(`${tableName}: fetchBatchSize=${fetchBatchSize}, using Appender API (no insert batch size limit)`);

        for await (const fetchedBatch of this.mysql.streamTableData(tableName, fetchBatchSize)) {
          // Append each row using Appender API
          for (const record of fetchedBatch) {
            // Append each column value using appropriate method based on MySQL type
            for (const col of columns) {
              const value = this.sanitizeValue(record[col], columnTypes.get(col) || '');
              const mysqlType = columnTypes.get(col) || '';

              // Append value based on MySQL type
              this.appendValueByType(appender, value, mysqlType);
            }

            // End row after all columns appended
            appender.endRow();
          }

          recordsProcessed += fetchedBatch.length;

          // Log progress for large tables
          if (totalRecords >= PROGRESS_LOG_INTERVAL && recordsProcessed - lastLoggedAt >= PROGRESS_LOG_INTERVAL) {
            const percent = ((recordsProcessed / totalRecords) * 100).toFixed(1);
            logger.info(`${tableName}: Processing... ${recordsProcessed.toLocaleString()}/${totalRecords.toLocaleString()} records (${percent}%)`);
            lastLoggedAt = recordsProcessed;
          }

          logger.debug(`Appended ${fetchedBatch.length} records to ${tableName}, total: ${recordsProcessed}`);
        }

        // Flush and close Appender (commits data)
        logger.debug(`${tableName}: Flushing Appender...`);
        appender.flushSync();
        appender.closeSync();
        conn.closeSync();
        logger.info(`${tableName}: Appender flushed and closed successfully`);

        // IMPORTANT: Force CHECKPOINT to flush WAL and ensure data durability
        // Ensures all changes are persisted to the database file immediately
        logger.debug(`${tableName}: Running CHECKPOINT to flush WAL...`);
        await this.duckdb.run('CHECKPOINT');
        logger.info(`${tableName}: CHECKPOINT completed, data persisted successfully`);

        // Get max ID for watermark (supports both numeric and string IDs)
        const primaryKeyColumn = await this.detectPrimaryKeyColumn(tableName, schema);
        let maxId: string | number | undefined = undefined;

        if (primaryKeyColumn && recordsProcessed > 0) {
          try {
            const maxResult = await this.duckdb.execute(`SELECT MAX(${primaryKeyColumn}) as max_id FROM ${tableName}`);
            // execute() returns objects with column names
            if (maxResult.length > 0 && maxResult[0]?.max_id !== null && maxResult[0]?.max_id !== undefined) {
              // Convert BigInt to number for numeric IDs, keep strings as-is
              const value = maxResult[0].max_id;
              if (typeof value === 'bigint') {
                maxId = Number(value);
              } else if (typeof value === 'string' || typeof value === 'number') {
                maxId = value;
              } else {
                maxId = String(value);
              }
            }
          } catch (error) {
            logger.warn(`Failed to get max ID for ${tableName}:`, error);
          }
        }

        // Update watermark
        await this.updateWatermark(tableName, {
          lastProcessedId: maxId,
          lastProcessedTimestamp: new Date(),
          primaryKeyColumn: primaryKeyColumn,
          timestampColumn: await this.detectTimestampColumn(tableName, schema)
        });

        logger.info(`Appender-based sync completed for ${tableName}: ${recordsProcessed} records`);

      } catch (error) {
        logger.error(`Appender sync failed for ${tableName}, error:`, error);
        throw error;
      }

      const duration = Date.now() - startTime;

      // Log success
      await this.logSyncOperation(tableName, 'sequential', recordsProcessed, duration, 'success', watermarkBefore);

      return {
        table: tableName,
        recordsProcessed,
        duration,
        status: 'success',
        syncType: 'sequential'
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Log error
      await this.logSyncOperation(tableName, 'sequential', 0, duration, 'error', undefined, errorMessage);

      logger.warn(`Appender-based sync failed for ${tableName}, falling back to INSERT method:`, error);

      // Fallback to traditional INSERT method
      try {
        logger.info(`Attempting fallback to INSERT-based sync for ${tableName}...`);
        return await this.syncTableSequential(tableName);
      } catch (fallbackError) {
        logger.error(`Fallback INSERT sync also failed for ${tableName}:`, fallbackError);
        return {
          table: tableName,
          recordsProcessed: 0,
          duration: Date.now() - startTime,
          status: 'error',
          error: `Appender failed: ${errorMessage}, INSERT fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
          syncType: 'sequential'
        };
      }
    }
  }

  /**
   * Watermark-based incremental sync - process only new records
   *
   * Uses watermarks to track last processed record and sync only new/updated data
   */
  private async syncTableWatermark(tableName: string): Promise<AppenderSyncResult> {
    const startTime = Date.now();

    try {
      logger.info(`Starting watermark incremental sync for table: ${tableName}`);

      // Get current watermark
      const watermark = await this.getTableWatermark(tableName);

      if (!watermark) {
        // No watermark exists, fall back to sequential sync with Appender (6-10x faster)
        logger.info(`No watermark found for ${tableName}, performing sequential sync with Appender`);
        return await this.syncTableSequentialWithAppender(tableName);
      }

      // Debug logging for watermark validation
      logger.info(`${tableName} watermark - ID: ${watermark.lastProcessedId}, TS: ${watermark.lastProcessedTimestamp?.toISOString()}, PKCol: ${watermark.primaryKeyColumn}, TSCol: ${watermark.timestampColumn}`);


      // Get table schema (will fail if table doesn't exist in MySQL)
      const schema = await this.getSchemaOrCleanup(tableName, startTime);
      if (!schema) {
        // Table was deleted from MySQL
        return {
          table: tableName,
          recordsProcessed: 0,
          duration: Date.now() - startTime,
          status: 'error',
          error: 'Table does not exist in MySQL',
          syncType: 'watermark'
        };
      }

      // Ensure table exists (adds new columns if needed)
      await this.ensureTableExists(tableName, schema);

      let recordsProcessed = 0;
      let incrementalData: any[] = [];

      // Get incremental data based on watermark
      if (watermark.lastProcessedTimestamp && watermark.timestampColumn) {
        // Use timestamp-based incremental sync
        incrementalData = await this.mysql.getIncrementalData(
          tableName,
          watermark.lastProcessedTimestamp,
          50000 // Large batch for efficiency
        );
        logger.info(`Found ${incrementalData.length} incremental records for ${tableName} since ${watermark.lastProcessedTimestamp}`);
      } else if (watermark.lastProcessedId && watermark.primaryKeyColumn) {
        // Use ID-based incremental sync
        incrementalData = await this.mysql.execute(
          `SELECT * FROM ${tableName} WHERE ${watermark.primaryKeyColumn} > ? ORDER BY ${watermark.primaryKeyColumn} ASC LIMIT 50000`,
          [watermark.lastProcessedId]
        );
        logger.info(`Found ${incrementalData.length} incremental records for ${tableName} since ID ${watermark.lastProcessedId}`);
      } else {
        // No proper watermark columns, fall back to sequential with Appender (6-10x faster)
        logger.warn(`Invalid watermark for ${tableName}, falling back to sequential sync with Appender`);
        return await this.syncTableSequentialWithAppender(tableName);
      }

      if (incrementalData.length === 0) {
        const duration = Date.now() - startTime;
        logger.info(`No incremental data found for ${tableName}`);

        return {
          table: tableName,
          recordsProcessed: 0,
          duration,
          status: 'success',
          syncType: 'watermark'
        };
      }

      // Start transaction for atomic operation

      try {
        // Get column names for INSERT OR REPLACE statement (upsert)
        const columns = schema.map(col => col.Field);

        // Create column type map for sanitization
        const columnTypes = new Map(schema.map(col => [col.Field, col.Type]));

        // Calculate safe insert batch size based on column count
        // JavaScript/Node.js has ~65K function argument limit
        const columnCount = schema.length;
        const maxSafeBatchSize = Math.floor(65000 / columnCount); // Safety margin for parameter binding
        const insertBatchSize = Math.min(config.sync.insertBatchSize, maxSafeBatchSize);

        logger.info(`${tableName}: watermark sync - columns=${columnCount}, insertBatchSize=${insertBatchSize} (max safe: ${maxSafeBatchSize})`);

        // Process incremental data in batches to avoid stack overflow
        for (let i = 0; i < incrementalData.length; i += insertBatchSize) {
          const batch = incrementalData.slice(i, i + insertBatchSize);

          // Build bulk INSERT OR REPLACE query for incremental records
          const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
          const allPlaceholders = batch.map(() => rowPlaceholders).join(', ');
          const bulkInsertQuery = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES ${allPlaceholders}`;

          // Flatten all values into single array for bulk insert
          const allValues: any[] = [];
          for (const record of batch) {
            for (const col of columns) {
              allValues.push(this.sanitizeValue(record[col], columnTypes.get(col) || ''));
            }
          }

          // Execute bulk upsert (much faster than individual inserts)
          await this.duckdb.run(bulkInsertQuery, allValues);

          recordsProcessed += batch.length;
        }

        // Commit transaction

        // Update watermark
        const lastRecord = incrementalData[incrementalData.length - 1];
        const newWatermark: Partial<TableWatermark> = {
          lastProcessedTimestamp: new Date(),
          primaryKeyColumn: watermark.primaryKeyColumn,
          timestampColumn: watermark.timestampColumn
        };

        if (watermark.primaryKeyColumn && lastRecord[watermark.primaryKeyColumn]) {
          newWatermark.lastProcessedId = lastRecord[watermark.primaryKeyColumn];
        }

        if (watermark.timestampColumn && lastRecord[watermark.timestampColumn]) {
          newWatermark.lastProcessedTimestamp = new Date(lastRecord[watermark.timestampColumn]);
        }

        await this.updateWatermark(tableName, newWatermark);

        logger.info(`Watermark incremental sync completed for ${tableName}: ${recordsProcessed} records`);

      } catch (error) {
        // Rollback on any error
        throw error;
      }

      const duration = Date.now() - startTime;

      // Log success
      await this.logSyncOperation(tableName, 'watermark', recordsProcessed, duration, 'success', watermark);

      return {
        table: tableName,
        recordsProcessed,
        duration,
        status: 'success',
        syncType: 'watermark',
        watermark: {
          lastProcessedId: watermark.lastProcessedId,
          lastProcessedTimestamp: watermark.lastProcessedTimestamp,
          primaryKey: watermark.primaryKeyColumn
        }
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Log error
      await this.logSyncOperation(tableName, 'watermark', 0, duration, 'error', undefined, errorMessage);

      logger.error(`Watermark incremental sync failed for ${tableName}:`, error);

      return {
        table: tableName,
        recordsProcessed: 0,
        duration,
        status: 'error',
        error: errorMessage,
        syncType: 'watermark'
      };
    }
  }

  /**
   * Ensure table exists with proper schema and handle schema evolution
   * - Creates table if it doesn't exist
   * - Adds new columns if MySQL schema has new columns
   */
  private async ensureTableExists(tableName: string, mysqlSchema: any[]): Promise<void> {
    try {
      // Check if a view exists with this name and drop it
      const views = await this.duckdb.execute(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'main' AND table_name = ? AND table_type = 'VIEW'
      `, [tableName]);

      if (views.length > 0) {
        // Drop the view to allow creating a base table
        await this.duckdb.run(`DROP VIEW IF EXISTS ${tableName}`);
        logger.info(`Dropped view ${tableName} to create base table`);
      }

      // Check if table exists
      const tables = await this.duckdb.execute(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'main' AND table_name = ? AND table_type = 'BASE TABLE'
      `, [tableName]);

      if (tables.length === 0) {
        // Create table with proper schema
        await this.createTable(tableName, mysqlSchema);
        return;
      }

      // Table exists - check for new columns and add them
      await this.handleSchemaEvolution(tableName, mysqlSchema);
    } catch (error) {
      logger.error(`Failed to ensure table ${tableName} exists:`, error);
      throw error;
    }
  }

  /**
   * Create a new table with the given schema
   */
  private async createTable(tableName: string, schema: any[]): Promise<void> {
    const primaryKeyColumns = schema.filter(col => col.Key === 'PRI').map(col => col.Field);

    const columns = schema.map(col => {
      const type = this.mapMySQLTypeToDuckDB(col.Type);
      // Always make all columns nullable
      // MySQL often has NULL values even in NOT NULL columns due to legacy data or lenient enforcement
      // DuckDB enforces constraints strictly, so we allow NULL to prevent sync failures

      // Don't add PRIMARY KEY constraint here - we'll add it separately
      return `${col.Field} ${type}`;
    });

    // Add composite primary key constraint if there are primary key columns
    if (primaryKeyColumns.length > 0) {
      columns.push(`PRIMARY KEY (${primaryKeyColumns.join(', ')})`);
    }

    const createQuery = `CREATE TABLE ${tableName} (${columns.join(', ')})`;
    await this.duckdb.run(createQuery);

    logger.info(`Created table ${tableName} with ${schema.length} columns${primaryKeyColumns.length > 0 ? ` and primary key: (${primaryKeyColumns.join(', ')})` : ''}`);
  }

  /**
   * Handle schema evolution - add new columns from MySQL to DuckDB
   * Only handles adding columns; other changes are ignored
   */
  private async handleSchemaEvolution(tableName: string, mysqlSchema: any[]): Promise<boolean> {
    try {
      // Get current DuckDB schema
      const duckdbColumns = await this.duckdb.execute(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'main' AND table_name = ?
        ORDER BY ordinal_position
      `, [tableName]);

      const duckdbColumnNames = new Set(duckdbColumns.map(col => col.column_name.toLowerCase()));

      // Find new columns (in MySQL but not in DuckDB)
      const newColumns = mysqlSchema.filter(col => !duckdbColumnNames.has(col.Field.toLowerCase()));

      if (newColumns.length === 0) {
        return false; // No new columns
      }

      // Add new columns via ALTER TABLE
      for (const col of newColumns) {
        const type = this.mapMySQLTypeToDuckDB(col.Type);

        // Add column - DuckDB defaults to NULL for new columns
        const alterQuery = `ALTER TABLE ${tableName} ADD COLUMN ${col.Field} ${type}`;
        await this.duckdb.run(alterQuery);

        logger.info(`Schema evolution: Added column '${col.Field}' (${type}) to table ${tableName}`);
      }

      return false; // No rebuild needed
    } catch (error) {
      logger.error(`Failed to handle schema evolution for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Get table schema and handle deleted tables
   * Returns schema if table exists, null if table was deleted from MySQL
   */
  private async getSchemaOrCleanup(tableName: string, startTime: number): Promise<any[] | null> {
    try {
      return await this.mysql.getTableSchema(tableName);
    } catch (error: any) {
      // Table doesn't exist in MySQL - clean up DuckDB
      if (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146) {
        logger.warn(`Table ${tableName} does not exist in MySQL, cleaning up from DuckDB`);
        try {
          await this.duckdb.run(`DROP TABLE IF EXISTS ${tableName}`);
          await this.duckdb.run('DELETE FROM appender_watermarks WHERE table_name = ?', [tableName]);
          logger.info(`Deleted orphaned table ${tableName} from DuckDB`);
        } catch (cleanupError) {
          logger.error(`Failed to cleanup table ${tableName}:`, cleanupError);
        }
        return null; // Signal that table was deleted
      }
      throw error; // Re-throw if it's a different error
    }
  }

  /**
   * Clean up tables in DuckDB that no longer exist in MySQL
   */
  private async cleanupDeletedTables(mysqlTables: string[]): Promise<void> {
    try {
      // Get all tables from DuckDB
      const duckdbTables = await this.duckdb.getTables();

      // Find tables that exist in DuckDB but not in MySQL
      const mysqlTableSet = new Set(mysqlTables.map(t => t.toLowerCase()));
      const tablesToDelete = duckdbTables.filter(table => {
        // Skip system tables
        if (table === 'appender_watermarks' || table === 'sync_log') {
          return false;
        }
        return !mysqlTableSet.has(table.toLowerCase());
      });

      if (tablesToDelete.length === 0) {
        return;
      }

      logger.info(`Found ${tablesToDelete.length} tables to delete from DuckDB (no longer in MySQL):`, tablesToDelete);

      // Delete tables and their watermarks
      for (const table of tablesToDelete) {
        try {
          // Drop the table
          await this.duckdb.run(`DROP TABLE IF EXISTS ${table}`);
          logger.info(`Deleted table ${table} from DuckDB`);

          // Clean up watermark
          await this.duckdb.run('DELETE FROM appender_watermarks WHERE table_name = ?', [table]);

          // Clean up sync logs (optional - keep for audit trail)
          // await this.duckdb.run('DELETE FROM sync_log WHERE table_name = ?', [table]);
        } catch (error) {
          logger.error(`Failed to delete table ${table}:`, error);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup deleted tables:', error);
      // Don't throw - continue with sync even if cleanup fails
    }
  }

  /**
   * Map MySQL data types to DuckDB data types
   */
  private mapMySQLTypeToDuckDB(mysqlType: string): string {
    const type = mysqlType.toLowerCase();

    // Check string/text types FIRST (before numeric checks) to avoid false matches
    // e.g., enum('Internship') contains 'int' but should map to VARCHAR
    if (type.includes('enum')) return 'VARCHAR';
    if (type.includes('set')) return 'VARCHAR';
    if (type.includes('json')) return 'VARCHAR';
    if (type.includes('text')) return 'TEXT';
    if (type.includes('varchar') || type.includes('char')) return 'VARCHAR';
    if (type.includes('blob') || type.includes('binary')) return 'BLOB';

    // Timestamp and date types
    if (type.includes('timestamp')) return 'TIMESTAMP';
    if (type.includes('datetime')) return 'TIMESTAMP';
    if (type.includes('date')) return 'DATE';
    if (type.includes('time')) return 'TIME';

    // Numeric types (check these AFTER string types)
    // Use BIGINT for all integer types to prevent overflow errors
    // MySQL often has values that exceed INT32 range even in INT columns
    if (type.includes('bigint')) return 'BIGINT';
    if (type.includes('tinyint')) return 'TINYINT';
    if (type.includes('smallint')) return 'SMALLINT';
    if (type.includes('mediumint')) return 'BIGINT';  // Use BIGINT instead of INTEGER
    if (type.includes('int')) return 'BIGINT';  // Use BIGINT for all INT types
    if (type.includes('decimal') || type.includes('numeric')) return 'DECIMAL';
    if (type.includes('float')) return 'FLOAT';
    if (type.includes('double')) return 'DOUBLE';
    if (type.includes('boolean') || type.includes('bool')) return 'BOOLEAN';

    return 'VARCHAR';
  }

  /**
   * Detect primary key column from schema
   */
  private async detectPrimaryKeyColumn(tableName: string, schema: any[]): Promise<string | undefined> {
    // Check schema for primary key
    const pkColumn = schema.find(col => col.Key === 'PRI');
    if (pkColumn) {
      return pkColumn.Field;
    }

    // Check common ID patterns
    const idPatterns = [
      'id',
      `${tableName.toLowerCase()}id`,
      `${tableName.toLowerCase()}_id`,
    ];

    for (const pattern of idPatterns) {
      const column = schema.find(col =>
        col.Field.toLowerCase() === pattern
      );
      if (column) {
        return column.Field;
      }
    }

    return undefined;
  }

  /**
   * Detect timestamp column for incremental sync
   */
  private async detectTimestampColumn(tableName: string, schema: any[]): Promise<string | undefined> {
    const timestampPatterns = [
      'updated_at',
      'modified_at',
      'updatedAt',
      'modifiedAt',
      'timestamp',
      'created_at',
      'createdAt'
    ];

    for (const pattern of timestampPatterns) {
      const column = schema.find(col =>
        col.Field.toLowerCase() === pattern.toLowerCase()
      );
      if (column) {
        return column.Field;
      }
    }

    return undefined;
  }

  /**
   * Get table watermark
   */
  private async getTableWatermark(tableName: string): Promise<TableWatermark | null> {
    try {
      const result = await this.duckdb.executeInternal(`
        SELECT * FROM appender_watermarks WHERE table_name = ?
      `, [tableName]);

      if (result.length > 0) {
        const row = result[0];
        // executeInternal returns arrays: [table_name, last_processed_id, last_processed_timestamp, primary_key_column, timestamp_column, updated_at]

        // Convert DuckDB timestamp format to JavaScript Date
        // DuckDB returns timestamps as objects: {"micros": "1763212777581000"} or {"micros": 1763212777581000n}
        const convertTimestamp = (ts: any): Date | undefined => {
          if (!ts) return undefined;
          if (ts instanceof Date) return ts;
          if (typeof ts === 'object' && ts.micros !== undefined) {
            // Convert microseconds to milliseconds
            // Handle BigInt, string, or number
            let microsNumber: number;
            if (typeof ts.micros === 'bigint') {
              microsNumber = Number(ts.micros);
            } else if (typeof ts.micros === 'string') {
              microsNumber = parseInt(ts.micros);
            } else {
              microsNumber = ts.micros;
            }
            return new Date(microsNumber / 1000);
          }
          if (typeof ts === 'string' || typeof ts === 'number') {
            return new Date(ts);
          }
          return undefined;
        };

        return {
          tableName: row[0],
          lastProcessedId: row[1],
          lastProcessedTimestamp: convertTimestamp(row[2]),
          primaryKeyColumn: row[3],
          timestampColumn: row[4],
          updatedAt: convertTimestamp(row[5]) || new Date()
        };
      }

      return null;
    } catch (error) {
      logger.warn(`Failed to get watermark for ${tableName}:`, error);
      return null;
    }
  }

  /**
   * Update table watermark
   */
  private async updateWatermark(tableName: string, watermark: Partial<TableWatermark>): Promise<void> {
    try {
      await this.duckdb.run(`
        INSERT OR REPLACE INTO appender_watermarks
        (table_name, last_processed_id, last_processed_timestamp, primary_key_column, timestamp_column, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        tableName,
        watermark.lastProcessedId || null,
        watermark.lastProcessedTimestamp || null,
        watermark.primaryKeyColumn || null,
        watermark.timestampColumn || null
      ]);
    } catch (error) {
      logger.error(`Failed to update watermark for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Helper to serialize objects with BigInt values for JSON
   */
  private serializeWithBigInt(obj: any): string {
    return JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  }

  /**
   * Log sync operation
   */
  private async logSyncOperation(
    tableName: string,
    syncType: string,
    recordsProcessed: number,
    durationMs: number,
    status: string,
    watermarkBefore?: TableWatermark | null,
    errorMessage?: string
  ): Promise<void> {
    try {
      const watermarkAfter = await this.getTableWatermark(tableName);

      await this.duckdb.run(`
        INSERT INTO sync_log
        (id, table_name, sync_type, records_processed, duration_ms, status, error_message, watermark_before, watermark_after)
        VALUES (nextval('sync_log_id_seq'), ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        tableName,
        syncType,
        recordsProcessed,
        durationMs,
        status,
        errorMessage || null,
        watermarkBefore ? this.serializeWithBigInt(watermarkBefore) : null,
        watermarkAfter ? this.serializeWithBigInt(watermarkAfter) : null
      ]);
    } catch (error) {
      logger.error(`Failed to log sync operation for ${tableName}:`, error);
      // Don't throw - logging failure shouldn't stop the sync
    }
  }

  /**
   * Get sync status
   */
  async getSyncStatus(): Promise<any> {
    try {
      const watermarks = await this.duckdb.execute('SELECT * FROM appender_watermarks ORDER BY updated_at DESC');
      const recentLogs = await this.duckdb.execute(`
        SELECT * FROM sync_log
        ORDER BY created_at DESC
        LIMIT 20
      `);

      const mysqlTables = await this.mysql.getTables();
      const duckdbTables = await this.duckdb.getTables();

      return {
        watermarks,
        recentLogs,
        tables: {
          mysql: mysqlTables.length,
          duckdb: duckdbTables.length,
          synced: duckdbTables.length,
          pending: mysqlTables.filter(t => !duckdbTables.includes(t)).length
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get sync status:', error);
      throw error;
    }
  }

  /**
   * Validate data consistency between MySQL and DuckDB
   */
  async validateSync(): Promise<any> {
    try {
      const tables = await this.mysql.getTables();
      const validationResults = [];

      for (const table of tables) {
        const mysqlCount = await this.mysql.getTableRowCount(table);

        try {
          const duckdbCount = await this.duckdb.getTableRowCount(table);
          const watermark = await this.getTableWatermark(table);

          validationResults.push({
            table,
            mysqlCount,
            duckdbCount,
            match: mysqlCount === duckdbCount,
            difference: mysqlCount - duckdbCount,
            lastSync: watermark?.updatedAt || null,
            syncType: watermark ? 'watermark' : 'none'
          });
        } catch (error) {
          validationResults.push({
            table,
            mysqlCount,
            duckdbCount: 0,
            match: false,
            difference: mysqlCount,
            error: 'Table not found in DuckDB or query failed'
          });
        }
      }

      return {
        validationResults,
        summary: {
          totalTables: validationResults.length,
          matchingTables: validationResults.filter(r => r.match).length,
          mismatchedTables: validationResults.filter(r => !r.match && !r.error).length,
          errorTables: validationResults.filter(r => r.error).length,
          totalMysqlRecords: validationResults.reduce((sum, r) => sum + r.mysqlCount, 0),
          totalDuckdbRecords: validationResults.reduce((sum, r) => sum + r.duckdbCount, 0)
        }
      };
    } catch (error) {
      logger.error('Validation failed:', error);
      throw error;
    }
  }
}

export default SequentialAppenderService;
