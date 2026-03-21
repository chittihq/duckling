import { EventEmitter } from 'events';
import DuckDBConnection from '../database/duckdb';
import MySQLConnection from '../database/mysql';
import config from '../config';
import logger from '../logger';
import { DuckDBTimestampValue, DuckDBTimeValue } from '@duckdb/node-api';
import { createHash, randomUUID } from 'crypto';
import { WorkerPool } from '../workers/workerPool';
// Appender functionality now provided by unified DuckDBConnection class

export class SyncAlreadyInProgressError extends Error {
  constructor(message = 'Another sync operation is already in progress. Please wait for it to complete.') {
    super(message);
    this.name = 'SyncAlreadyInProgressError';
  }
}

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

export interface SyncProgressStatus {
  inProgress: boolean;
  type: 'full' | 'incremental' | null;
  tablesCompleted: number;
  tablesTotal: number;
  currentTable: string | null;
  recordsProcessed: number;
  startedAt: string | null;
  lastError: string | null;
}

type FullSyncSessionStatus = 'loading' | 'swapping' | 'completed' | 'abandoned';

interface FullSyncSession {
  tableName: string;
  sessionId: string;
  stagingTable: string;
  status: FullSyncSessionStatus;
  pkColumns: string[];
  lastPkCursor: any[] | null;
  recordsProcessed: number;
  schemaFingerprint: string;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
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
class SequentialAppenderService extends EventEmitter {
  private mysql: MySQLConnection;
  private duckdb: DuckDBConnection;
  private startupStagingCleanupPromise: Promise<void> | null = null;
  private startupStagingCleanupComplete = false;
  private static instances: Map<string, SequentialAppenderService> = new Map();
  private tableSyncLocks: Set<string> = new Set();
  private syncQueue: Array<{ tableName?: string; resolve: (value: any) => void; reject: (error: any) => void }> = [];
  private syncProgress: SyncProgressStatus = {
    inProgress: false,
    type: null,
    tablesCompleted: 0,
    tablesTotal: 0,
    currentTable: null,
    recordsProcessed: 0,
    startedAt: null,
    lastError: null
  };

  private constructor(mysql: MySQLConnection, duckdb: DuckDBConnection) {
    super();
    this.mysql = mysql;
    this.duckdb = duckdb;
  }

  /** Double-quote a DuckDB identifier, escaping embedded double-quotes. */
  private q(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  /** Build a unique staging table name for crash-safe full sync swaps. */
  private getStagingTablePrefix(tableName: string): string {
    const tablePrefix = tableName
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'table';
    return `__full_sync_staging_${tablePrefix}_`;
  }

  /** Build a unique staging table name for crash-safe full sync swaps. */
  private buildStagingTableName(tableName: string): string {
    return `${this.getStagingTablePrefix(tableName)}${randomUUID().replace(/-/g, '')}`;
  }

  /** Internal crash-recovery staging tables should never be treated as replicated user tables. */
  private isInternalStagingTable(tableName: string): boolean {
    return tableName.startsWith('__full_sync_staging_');
  }

  private describeDiagnosticValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
    if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
    if (value instanceof Date) return `Date(${value.toISOString()})`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (typeof value === 'bigint') return `bigint(${value.toString()})`;
    if (typeof value === 'object') return `object(${Object.keys(value as Record<string, unknown>).slice(0, 5).join(',')})`;
    return `${typeof value}(${String(value).slice(0, 120)})`;
  }

  private maybeLogCrashDiagnostics(message: string, details: Record<string, unknown>): void {
    if (!config.debug.crashDiagnostics) return;
    logger.info(message, details);
  }

  private getPrimaryKeyColumnsFromSchema(schema: any[]): string[] {
    return schema.filter(col => col.Key === 'PRI').map(col => col.Field);
  }

  private buildPrimaryKeyJoinPredicate(leftAlias: string, rightAlias: string, primaryKeyColumns: string[]): string {
    return primaryKeyColumns
      .map((column) => `${leftAlias}.${this.q(column)} = ${rightAlias}.${this.q(column)}`)
      .join(' AND ');
  }

  private async buildAlignedInsertSql(targetTable: string, sourceTable: string, sourceColumns: string[]): Promise<string> {
    const targetRows = await this.duckdb.execute(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'main' AND table_name = ?
      ORDER BY ordinal_position
    `, [targetTable]);

    const targetColumns = targetRows
      .map((row) => (typeof row.column_name === 'string' ? row.column_name : null))
      .filter((column): column is string => Boolean(column));

    if (targetColumns.length === 0) {
      throw new Error(`Target table ${targetTable} has no columns in DuckDB metadata`);
    }

    const targetColumnsByLower = new Map(targetColumns.map((column) => [column.toLowerCase(), column]));
    const missingTargetColumns = sourceColumns.filter((column) => !targetColumnsByLower.has(column.toLowerCase()));

    if (missingTargetColumns.length > 0) {
      throw new Error(
        `Target table ${targetTable} is missing source column(s): ${missingTargetColumns.join(', ')}. ` +
        `A rebuild is required before syncing from staging table ${sourceTable}.`
      );
    }

    const alignedTargetColumns = sourceColumns.map((column) => targetColumnsByLower.get(column.toLowerCase())!);
    const targetColumnList = alignedTargetColumns.map((column) => this.q(column)).join(', ');
    const sourceColumnList = sourceColumns.map((column) => this.q(column)).join(', ');

    return `INSERT INTO ${this.q(targetTable)} (${targetColumnList}) SELECT ${sourceColumnList} FROM ${this.q(sourceTable)}`;
  }

  private isFullSyncResumeEnabled(): boolean {
    return config.sync.fullSyncResumeEnabled;
  }

  private computeSchemaFingerprint(schema: any[]): string {
    const normalizedSchema = schema.map((col) => ({
      field: String(col.Field),
      type: String(col.Type),
      key: String(col.Key || ''),
      nullable: String(col.Null || ''),
    }));

    return createHash('sha256').update(JSON.stringify(normalizedSchema)).digest('hex');
  }

  private toDateOrNull(value: unknown): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private parseCursorJson(value: unknown): any[] | null {
    if (typeof value !== 'string' || value.length === 0) return null;

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      logger.warn('Failed to parse full sync cursor JSON:', error);
      return null;
    }
  }

  private async getFullSyncSession(tableName: string): Promise<FullSyncSession | null> {
    try {
      const rows = await this.duckdb.execute(`
        SELECT
          table_name,
          session_id,
          staging_table,
          status,
          pk_columns_json,
          last_pk_cursor_json,
          records_processed,
          schema_fingerprint,
          error_message,
          started_at,
          updated_at,
          completed_at
        FROM full_sync_sessions
        WHERE table_name = ?
      `, [tableName]);

      const row = rows[0];
      if (!row || typeof row.table_name !== 'string') {
        return null;
      }

      let pkColumns: string[] = [];
      try {
        const parsed = JSON.parse(String(row.pk_columns_json || '[]'));
        if (Array.isArray(parsed)) {
          pkColumns = parsed.map((value) => String(value));
        }
      } catch (error) {
        logger.warn(`Failed to parse primary key metadata for full sync session ${tableName}:`, error);
      }

      const recordsProcessedValue = row.records_processed;
      const recordsProcessed = typeof recordsProcessedValue === 'bigint'
        ? Number(recordsProcessedValue)
        : Number(recordsProcessedValue || 0);

      return {
        tableName: row.table_name,
        sessionId: String(row.session_id),
        stagingTable: String(row.staging_table),
        status: row.status as FullSyncSessionStatus,
        pkColumns,
        lastPkCursor: this.parseCursorJson(row.last_pk_cursor_json),
        recordsProcessed: Number.isFinite(recordsProcessed) ? recordsProcessed : 0,
        schemaFingerprint: String(row.schema_fingerprint),
        errorMessage: row.error_message ? String(row.error_message) : null,
        startedAt: this.toDateOrNull(row.started_at) || new Date(),
        updatedAt: this.toDateOrNull(row.updated_at) || new Date(),
        completedAt: this.toDateOrNull(row.completed_at),
      };
    } catch (error) {
      logger.warn(`Failed to load full sync session for ${tableName}:`, error);
      return null;
    }
  }

  private async getTrackedResumableStagingTables(): Promise<Set<string>> {
    try {
      const rows = await this.duckdb.execute(`
        SELECT staging_table
        FROM full_sync_sessions
        WHERE status IN ('loading', 'swapping')
      `);

      return new Set(
        rows
          .map((row: any) => (typeof row?.staging_table === 'string' ? row.staging_table : null))
          .filter((value: string | null): value is string => Boolean(value))
      );
    } catch {
      return new Set();
    }
  }

  private async saveFullSyncSession(session: FullSyncSession): Promise<void> {
    await this.duckdb.run(`
      INSERT OR REPLACE INTO full_sync_sessions
      (
        table_name,
        session_id,
        staging_table,
        status,
        pk_columns_json,
        last_pk_cursor_json,
        records_processed,
        schema_fingerprint,
        error_message,
        started_at,
        updated_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      session.tableName,
      session.sessionId,
      session.stagingTable,
      session.status,
      JSON.stringify(session.pkColumns),
      session.lastPkCursor ? this.serializeWithBigInt(session.lastPkCursor) : null,
      session.recordsProcessed,
      session.schemaFingerprint,
      session.errorMessage,
      session.startedAt,
      session.updatedAt,
      session.completedAt,
    ]);
  }

  private async createFreshFullSyncSession(
    tableName: string,
    schema: any[],
    primaryKeyColumns: string[],
    schemaFingerprint: string,
  ): Promise<FullSyncSession> {
    const session: FullSyncSession = {
      tableName,
      sessionId: randomUUID().replace(/-/g, ''),
      stagingTable: this.buildStagingTableName(tableName),
      status: 'loading',
      pkColumns: [...primaryKeyColumns],
      lastPkCursor: null,
      recordsProcessed: 0,
      schemaFingerprint,
      errorMessage: null,
      startedAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };

    await this.createTable(session.stagingTable, schema, { includePrimaryKey: false });
    await this.saveFullSyncSession(session);
    return session;
  }

  private async abandonFullSyncSession(session: FullSyncSession, reason: string): Promise<void> {
    const abandonedSession: FullSyncSession = {
      ...session,
      status: 'abandoned',
      errorMessage: reason,
      updatedAt: new Date(),
      completedAt: new Date(),
    };
    await this.saveFullSyncSession(abandonedSession);
  }

  private async stageTableExists(tableName: string): Promise<boolean> {
    const rows = await this.duckdb.execute(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'main'
        AND table_name = ?
        AND table_type = 'BASE TABLE'
    `, [tableName]);

    return rows.length > 0;
  }

  private async prepareFullSyncSession(
    tableName: string,
    schema: any[],
    primaryKeyColumns: string[],
  ): Promise<FullSyncSession> {
    const schemaFingerprint = this.computeSchemaFingerprint(schema);
    const existingSession = await this.getFullSyncSession(tableName);

    if (!existingSession || existingSession.status === 'completed' || existingSession.status === 'abandoned') {
      return this.createFreshFullSyncSession(tableName, schema, primaryKeyColumns, schemaFingerprint);
    }

    const sameSchema = existingSession.schemaFingerprint === schemaFingerprint;
    const samePrimaryKeys = JSON.stringify(existingSession.pkColumns) === JSON.stringify(primaryKeyColumns);
    const stagingExists = await this.stageTableExists(existingSession.stagingTable);
    const hasValidCursorShape = existingSession.lastPkCursor === null
      || existingSession.lastPkCursor.length === primaryKeyColumns.length;

    if (!sameSchema || !samePrimaryKeys || !stagingExists || !hasValidCursorShape) {
      const reasons = [
        !sameSchema ? 'schema changed' : null,
        !samePrimaryKeys ? 'primary key columns changed' : null,
        !stagingExists ? 'staging table missing' : null,
        !hasValidCursorShape ? 'stored cursor is invalid' : null,
      ].filter((value): value is string => Boolean(value));

      await this.abandonFullSyncSession(existingSession, reasons.join('; '));
      return this.createFreshFullSyncSession(tableName, schema, primaryKeyColumns, schemaFingerprint);
    }

    return existingSession;
  }

  private buildLexicographicGreaterThanPredicate(columns: string[], values: any[]): { sql: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    for (let index = 0; index < columns.length; index++) {
      const parts: string[] = [];
      for (let prefix = 0; prefix < index; prefix++) {
        parts.push(`${this.q(columns[prefix])} = ?`);
        params.push(values[prefix]);
      }
      parts.push(`${this.q(columns[index])} > ?`);
      params.push(values[index]);
      clauses.push(parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0]);
    }

    return { sql: clauses.join(' OR '), params };
  }

  private async prepareResumedFullSyncStaging(session: FullSyncSession): Promise<void> {
    if (session.status !== 'loading') return;

    if (!session.lastPkCursor || session.recordsProcessed <= 0) {
      await this.duckdb.run(`DELETE FROM ${this.q(session.stagingTable)}`);
      return;
    }

    const { sql, params } = this.buildLexicographicGreaterThanPredicate(session.pkColumns, session.lastPkCursor);
    await this.duckdb.run(`DELETE FROM ${this.q(session.stagingTable)} WHERE ${sql}`, params);
  }

  private async updateFullSyncSessionProgress(
    session: FullSyncSession,
    lastPkCursor: any[] | null,
    recordsProcessed: number,
  ): Promise<FullSyncSession> {
    const updatedSession: FullSyncSession = {
      ...session,
      lastPkCursor: lastPkCursor ? [...lastPkCursor] : null,
      recordsProcessed,
      updatedAt: new Date(),
      errorMessage: null,
    };

    await this.saveFullSyncSession(updatedSession);
    return updatedSession;
  }

  private async updateFullSyncSessionStatus(
    session: FullSyncSession,
    status: FullSyncSessionStatus,
    errorMessage: string | null = null,
  ): Promise<FullSyncSession> {
    const updatedSession: FullSyncSession = {
      ...session,
      status,
      errorMessage,
      updatedAt: new Date(),
      completedAt: status === 'completed' || status === 'abandoned' ? new Date() : session.completedAt,
    };

    await this.saveFullSyncSession(updatedSession);
    return updatedSession;
  }

  /** Best-effort table cleanup that never masks the original sync outcome. */
  private async dropTableIfExists(tableName: string, context: string): Promise<void> {
    try {
      await this.duckdb.run(`DROP TABLE IF EXISTS ${this.q(tableName)}`);
    } catch (error) {
      logger.warn(`Failed to drop ${tableName} during ${context}:`, error);
    }
  }

  /**
   * Detect stale staging tables left by previous crashed/aborted syncs.
   *
   * We intentionally do not drop them from the hot sync path. In damaged DB/WAL states,
   * even a best-effort DROP on crash residue has triggered native DuckDB failures.
   */
  private async cleanupOrphanStagingTables(tableName: string, activeStagingTable?: string): Promise<void> {
    const stagingPrefix = this.getStagingTablePrefix(tableName);

    try {
      const rows = await this.duckdb.execute(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'main'
          AND substr(table_name, 1, ?) = ?
      `, [stagingPrefix.length, stagingPrefix]);

      const staleTableNames: string[] = [];
      const activeStagingTables = await this.getTrackedResumableStagingTables();
      for (const row of rows) {
        const staleTableName = typeof row?.table_name === 'string' ? row.table_name : null;
        if (!staleTableName) continue;
        if (activeStagingTable && staleTableName === activeStagingTable) continue;
        if (activeStagingTables.has(staleTableName)) continue;
        staleTableNames.push(staleTableName);
      }

      if (staleTableNames.length > 0) {
        logger.warn(
          `${tableName}: Ignoring ${staleTableNames.length} orphan staging table(s) from a previous interrupted sync`,
          { staleTables: staleTableNames }
        );
      }
    } catch (error) {
      logger.warn(`${tableName}: Failed to list orphan staging tables`, error);
    }
  }

  /**
   * Detect crash-left staging tables once after process startup.
   *
   * We exclude them from normal table listings and sync cleanup, then leave them alone until manual
   * maintenance. This keeps restart recovery from poking a possibly damaged staging artifact.
   */
  private async ensureStartupStagingCleanup(): Promise<void> {
    if (this.startupStagingCleanupComplete) return;
    if (typeof (this.duckdb as any).execute !== 'function') {
      this.startupStagingCleanupComplete = true;
      return;
    }
    if (this.startupStagingCleanupPromise) {
      await this.startupStagingCleanupPromise;
      return;
    }

    this.startupStagingCleanupPromise = (async () => {
      try {
        const rows = await this.duckdb.execute(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'main'
            AND substr(table_name, 1, 20) = '__full_sync_staging_'
        `);

        const staleTableNames: string[] = [];
        const activeStagingTables = await this.getTrackedResumableStagingTables();
        for (const row of rows) {
          const staleTableName = typeof row?.table_name === 'string' ? row.table_name : null;
          if (!staleTableName) continue;
          if (activeStagingTables.has(staleTableName)) continue;
          staleTableNames.push(staleTableName);
        }

        if (staleTableNames.length > 0) {
          logger.warn(`Startup detected ${staleTableNames.length} orphan staging table(s); leaving them untouched`, {
            staleTables: staleTableNames
          });
        }

        this.startupStagingCleanupComplete = true;
      } catch (error) {
        logger.warn('Failed to perform startup orphan staging cleanup:', error);
      } finally {
        this.startupStagingCleanupPromise = null;
      }
    })();

    await this.startupStagingCleanupPromise;
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
   * - JSON: ✅ Supported (maps to JSON in DuckDB, values stringified)
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
    // JSON → JSON (stringified), BLOB → BLOB, all numeric/date types supported
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
   * Check if a batch sync (fullSync/incrementalSync) is currently in progress
   */
  isSyncInProgress(): boolean {
    return this.tableSyncLocks.size > 0;
  }

  /**
   * Check if a sync operation is currently in progress for a specific table.
   */
  isTableSyncInProgress(tableName: string): boolean {
    return this.tableSyncLocks.has(tableName);
  }

  getSyncProgress(): SyncProgressStatus {
    return { ...this.syncProgress };
  }

  /**
   * Try to acquire per-table sync lock.
   * Returns false if the table is already being synced.
   */
  private tryAcquireTableLock(tableName: string): boolean {
    if (this.tableSyncLocks.has(tableName)) {
      return false;
    }
    this.tableSyncLocks.add(tableName);
    return true;
  }

  /**
   * Acquire per-table sync lock for single-table syncs.
   * Throws if the specific table is already being synced.
   */
  private acquireTableLock(tableName: string): void {
    if (this.tableSyncLocks.has(tableName)) {
      throw new SyncAlreadyInProgressError(`Sync already in progress for table '${tableName}'. Please wait for it to complete.`);
    }
    this.tableSyncLocks.add(tableName);
  }

  /**
   * Release per-table sync lock
   */
  private releaseTableLock(tableName: string): void {
    this.tableSyncLocks.delete(tableName);
  }

  /**
   * Full sync using sequential processing for all tables
   */
  async fullSync(): Promise<AppenderSyncStats> {
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
      this.syncProgress = {
        inProgress: true,
        type: 'full',
        tablesCompleted: 0,
        tablesTotal: tables.length,
        currentTable: null,
        recordsProcessed: 0,
        startedAt: new Date().toISOString(),
        lastError: null
      };
      this.emit('syncProgress');

      await this.ensureStartupStagingCleanup();

      // Clean up tables that were deleted from MySQL
      await this.cleanupDeletedTables(tables);

      for (const table of tables) {
        // Acquire per-table lock so single-table syncs cannot race this table
        if (!this.tryAcquireTableLock(table)) {
          logger.info(`Skipping table ${table}: sync already in progress`);
          this.syncProgress.tablesCompleted += 1;
          this.emit('syncProgress');
          continue;
        }
        try {
          this.syncProgress.currentTable = table;
          this.emit('syncProgress');
          // Use Appender API for full sync (6-10x faster than INSERT)
          // Falls back to INSERT automatically on any Appender error
          const result = await this.syncTableSequentialWithAppender(table);
          this.syncProgress.tablesCompleted += 1;
          this.syncProgress.recordsProcessed += result.recordsProcessed;
          this.emit('syncProgress');

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
        } finally {
          this.releaseTableLock(table);
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
      this.syncProgress.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.emit('syncProgress');
      throw error;
    } finally {
      this.syncProgress.inProgress = false;
      this.syncProgress.currentTable = null;
      this.syncProgress.type = null;
      this.emit('syncProgress');
    }
  }

  /**
   * Incremental sync using watermarks for efficient processing
   */
  async incrementalSync(): Promise<AppenderSyncStats> {
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
      this.syncProgress = {
        inProgress: true,
        type: 'incremental',
        tablesCompleted: 0,
        tablesTotal: tables.length,
        currentTable: null,
        recordsProcessed: 0,
        startedAt: new Date().toISOString(),
        lastError: null
      };
      this.emit('syncProgress');

      await this.ensureStartupStagingCleanup();

      // Clean up tables that were deleted from MySQL
      await this.cleanupDeletedTables(tables);

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        // Acquire per-table lock so single-table syncs cannot race this table
        if (!this.tryAcquireTableLock(table)) {
          logger.info(`[${i + 1}/${tables.length}] Skipping table ${table}: sync already in progress`);
          this.syncProgress.tablesCompleted += 1;
          this.emit('syncProgress');
          continue;
        }
        try {
          this.syncProgress.currentTable = table;
          this.emit('syncProgress');
          // Log table-level progress
          logger.info(`[${i + 1}/${tables.length}] Syncing table: ${table}...`);

          const result = await this.syncTableWatermark(table);
          this.syncProgress.tablesCompleted += 1;
          this.syncProgress.recordsProcessed += result.recordsProcessed;
          this.emit('syncProgress');

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
        } finally {
          this.releaseTableLock(table);
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
      this.syncProgress.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.emit('syncProgress');
      throw error;
    } finally {
      this.syncProgress.inProgress = false;
      this.syncProgress.currentTable = null;
      this.syncProgress.type = null;
      this.emit('syncProgress');
    }
  }

  /**
   * Sync a single table (uses watermark-based incremental sync if available, otherwise full sync)
   */
  async syncSingleTable(tableName: string): Promise<AppenderSyncResult> {
    // Acquire per-table lock — only blocks if this specific table is already syncing
    this.acquireTableLock(tableName);

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
      this.releaseTableLock(tableName);
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
      // All remaining INT types (int, mediumint, int unsigned) map to DuckDB BIGINT,
      // so we must use appendBigInt to match the column type exactly.
      appender.appendBigInt(BigInt(value));
    }
    // Float types
    else if (lowerType.includes('float')) {
      appender.appendFloat(Number(value));
    } else if (lowerType.includes('double')) {
      appender.appendDouble(Number(value));
    } else if (lowerType.includes('decimal') || lowerType.includes('numeric')) {
      // DuckDB DECIMAL columns require appendVarchar, not appendDouble.
      // mysql2 (with dateStrings:true) returns decimal values as strings already.
      appender.appendVarchar(String(value));
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
    // Date/Time types — order matters: check timestamp/datetime BEFORE time BEFORE date,
    // because "datetime" contains both "date" and "time" as substrings.
    else if (lowerType.includes('timestamp') || lowerType.includes('datetime')) {
      // appendVarchar on TIMESTAMP columns corrupts the Appender for fractional-second values.
      // Use the typed appendTimestamp method with parsed parts instead.
      const tsStr = value instanceof Date
        ? value.toISOString().replace('T', ' ').replace('Z', '')
        : String(value);
      const m = tsStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (m) {
        const micros = m[7] ? parseInt(m[7].padEnd(6, '0').slice(0, 6), 10) : 0;
        appender.appendTimestamp(DuckDBTimestampValue.fromParts({
          date: { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) },
          time: { hour: parseInt(m[4], 10), min: parseInt(m[5], 10), sec: parseInt(m[6], 10), micros },
        }));
      } else {
        appender.appendNull();
      }
    } else if (lowerType.includes('time')) {
      // appendVarchar with fractional seconds ('HH:MM:SS.ffffff') silently corrupts the Appender.
      // Use the typed appendTime method with parsed parts instead.
      const timeStr = String(value);
      const m = timeStr.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
      if (m) {
        const micros = m[4] ? parseInt(m[4].padEnd(6, '0').slice(0, 6), 10) : 0;
        appender.appendTime(DuckDBTimeValue.fromParts({
          hour: parseInt(m[1], 10), min: parseInt(m[2], 10), sec: parseInt(m[3], 10), micros,
        }));
      } else {
        appender.appendNull();
      }
    } else if (lowerType.includes('date')) {
      // For DATE type (not datetime/timestamp), MySQL returns 'YYYY-MM-DD' string;
      // DuckDB auto-converts varchar.
      appender.appendVarchar(String(value));
    }
    // BIT — MySQL returns Buffer; convert bytes to integer string for VARCHAR storage
    else if (lowerType.includes('bit')) {
      if (Buffer.isBuffer(value)) {
        let intVal = BigInt(0);
        for (let i = 0; i < value.length; i++) {
          intVal = (intVal << BigInt(8)) | BigInt(value[i]);
        }
        appender.appendVarchar(intVal.toString());
      } else {
        appender.appendVarchar(String(value));
      }
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
        return null;
      }
      // If it's already a string, return as-is, otherwise stringify
      if (typeof value === 'string') {
        return value;
      }
      return JSON.stringify(value);
    }

    // Handle invalid timestamps for timestamp/datetime/date columns
    if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType === 'date') {
      // Check if value is the invalid timestamp/date string
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
      // Note: This is an ESTIMATE and may be 10-20% off for InnoDB tables
      // Actual count may exceed this estimate during sync (will show ">100%")
      const totalRecords = await this.mysql.getTableRowCountFast(tableName);
      let lastLoggedAt = 0;
      const PROGRESS_LOG_INTERVAL = 10000;

      logger.info(`${tableName}: Starting transactional full refresh`);

      let transactionStarted = false;
      try {
        await this.duckdb.run('BEGIN TRANSACTION');
        transactionStarted = true;

        // Clear existing data for full sync and repopulate atomically
        await this.duckdb.run(`DELETE FROM ${this.q(tableName)}`);

        // Get column names for INSERT statement
        const columns = schema.map(col => col.Field);
        const quotedColumns = columns.map(col => this.q(col)).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const insertQuery = `INSERT INTO ${this.q(tableName)} (${quotedColumns}) VALUES (${placeholders})`;

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

        for await (const fetchedBatch of this.mysql.streamTableData(tableName, fetchBatchSize)) {
          // Process fetched batch in smaller bulk inserts to avoid stack overflow
          for (let i = 0; i < fetchedBatch.length; i += insertBatchSize) {
            const batch = fetchedBatch.slice(i, i + insertBatchSize);

            // Build bulk insert query with multiple rows
            // Format: INSERT INTO table (col1, col2) VALUES (?, ?), (?, ?), ...
            const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
            const allPlaceholders = batch.map(() => rowPlaceholders).join(', ');
            const bulkInsertQuery = `INSERT INTO ${this.q(tableName)} (${quotedColumns}) VALUES ${allPlaceholders}`;

            // Sanitize batch: use worker threads if enabled, otherwise main thread
            let allValues: any[];
            const pool = WorkerPool.getInstance();
            let useMainThread = pool.isDisabled;

            if (!useMainThread) {
              try {
                const columnTypesObj: Record<string, string> = {};
                for (const [k, v] of columnTypes) columnTypesObj[k] = v;
                const sanitizedRows = await pool.sanitizeBatch(batch, columns, columnTypesObj);
                // Flatten sanitized rows into single array for bulk insert
                allValues = [];
                for (const row of sanitizedRows) {
                  for (const val of row) {
                    allValues.push(val);
                  }
                }
              } catch (workerErr) {
                logger.warn(`${tableName}: Worker pool sanitization failed, falling back to main thread:`, workerErr);
                useMainThread = true;
              }
            }

            if (useMainThread) {
              allValues = [];
              for (const record of batch) {
                for (const col of columns) {
                  allValues.push(this.sanitizeValue(record[col], columnTypes.get(col) || ''));
                }
              }
            }

            // Execute bulk insert (10-100x faster than individual inserts)
            await this.duckdb.run(bulkInsertQuery, allValues!);

            recordsProcessed += batch.length;

            // Log progress for large tables
            if (totalRecords >= PROGRESS_LOG_INTERVAL && recordsProcessed - lastLoggedAt >= PROGRESS_LOG_INTERVAL) {
              const percent = ((recordsProcessed / totalRecords) * 100).toFixed(1);
              logger.info(`${tableName}: Processing... ${recordsProcessed.toLocaleString()}/${totalRecords.toLocaleString()} records (${percent}%)`);
              lastLoggedAt = recordsProcessed;
            }
          }

          logger.debug(`Bulk inserted ${fetchedBatch.length} records to ${tableName}, total: ${recordsProcessed}`);
        }

        await this.duckdb.run('COMMIT');
        transactionStarted = false;

        // Get max ID for watermark (supports both numeric and string IDs)
        const primaryKeyColumn = await this.detectPrimaryKeyColumn(tableName, schema);
        let maxId: string | number | undefined = undefined;

        if (primaryKeyColumn && recordsProcessed > 0) {
          try {
            const maxResult = await this.duckdb.execute(`SELECT MAX(${this.q(primaryKeyColumn)}) as max_id FROM ${this.q(tableName)}`);
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
        if (transactionStarted) {
          try {
            await this.duckdb.run('ROLLBACK');
          } catch (rollbackError) {
            logger.error(`Failed to rollback transaction for ${tableName}:`, rollbackError);
          }
        }
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
   * Notes:
   * - Supports JSON, BLOB, and BINARY types on DuckDB 1.2+.
   * - Falls back to syncTableSequential for complex or unsupported types when needed.
   */
  private async syncTableSequentialWithAppender(tableName: string): Promise<AppenderSyncResult> {
    const startTime = Date.now();
    let resumableSessionActive = false;

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
      // Note: This is an ESTIMATE and may be 10-20% off for InnoDB tables
      // Actual count may exceed this estimate during sync (will show ">100%")
      const totalRecords = await this.mysql.getTableRowCountFast(tableName);
      let lastLoggedAt = 0;
      const PROGRESS_LOG_INTERVAL = 10000;

      await this.ensureStartupStagingCleanup();
      const primaryKeyColumns = this.getPrimaryKeyColumnsFromSchema(schema);
      const resumableFullSync = this.isFullSyncResumeEnabled() && primaryKeyColumns.length > 0;

      let fullSyncSession: FullSyncSession | null = null;
      let stagingTable: string;

      if (resumableFullSync) {
        fullSyncSession = await this.prepareFullSyncSession(tableName, schema, primaryKeyColumns);
        resumableSessionActive = true;
        stagingTable = fullSyncSession.stagingTable;
        await this.cleanupOrphanStagingTables(tableName, stagingTable);

        if (fullSyncSession.status === 'loading') {
          await this.prepareResumedFullSyncStaging(fullSyncSession);
          recordsProcessed = fullSyncSession.recordsProcessed;
          lastLoggedAt = recordsProcessed;
          logger.info(
            `${tableName}: ${recordsProcessed > 0 ? 'Resuming' : 'Starting'} Appender-based insert into staging table ${stagingTable} ` +
            `(session ${fullSyncSession.sessionId}, processed=${recordsProcessed.toLocaleString()})`
          );
        } else {
          recordsProcessed = fullSyncSession.recordsProcessed;
          lastLoggedAt = recordsProcessed;
          logger.info(
            `${tableName}: Resuming transactional swap from staging table ${stagingTable} ` +
            `(session ${fullSyncSession.sessionId}, processed=${recordsProcessed.toLocaleString()})`
          );
        }
      } else {
        await this.cleanupOrphanStagingTables(tableName);
        stagingTable = this.buildStagingTableName(tableName);
        await this.createTable(stagingTable, schema, { includePrimaryKey: false });
        logger.info(`${tableName}: Starting Appender-based insert into staging table ${stagingTable}`);
      }

      let _appender: any = null;
      let _conn: any = null;
      let lastStreamCursor: any[] | null = fullSyncSession?.lastPkCursor ?? null;

      try {
        const columns = schema.map(col => col.Field);
        const columnTypes = new Map(schema.map(col => [col.Field, col.Type]));
        const fetchBatchSize = config.sync.fullSyncBatchSize; // Configurable via FULL_SYNC_BATCH_SIZE env var
        const FLUSH_INTERVAL = config.sync.fullSyncAppenderFlushInterval; // Configurable via FULL_SYNC_APPENDER_FLUSH_INTERVAL env var
        let lastFlushedAt = recordsProcessed;

        logger.info(`${tableName}: fetchBatchSize=${fetchBatchSize}, flushInterval=${FLUSH_INTERVAL}, using Appender API`);

        if (!fullSyncSession || fullSyncSession.status === 'loading') {
          // Create Appender instance for this table using unified DuckDB connection
          logger.debug(`${tableName}: Creating Appender instance for staging table ${stagingTable}...`);
          const { appender, connection: conn } = await this.duckdb.createAppender(stagingTable);
          _appender = appender;
          _conn = conn;
          logger.info(`${tableName}: Appender created successfully`);

          for await (const fetchedBatch of this.mysql.streamTableData(tableName, fetchBatchSize, lastStreamCursor)) {
            // Sanitize batch: use worker threads if enabled, otherwise main thread
            // (Appender API methods must run on main thread with DuckDB connection)
            let sanitizedRows: any[][];
            const pool = WorkerPool.getInstance();
            let useMainThread = pool.isDisabled;

            if (!useMainThread) {
              try {
                const columnTypesObj: Record<string, string> = {};
                for (const [k, v] of columnTypes) columnTypesObj[k] = v;
                sanitizedRows = await pool.sanitizeBatch(fetchedBatch, columns, columnTypesObj);
              } catch (workerErr) {
                logger.warn(`${tableName}: Worker pool sanitization failed, falling back to main thread:`, workerErr);
                useMainThread = true;
              }
            }

            if (useMainThread) {
              sanitizedRows = fetchedBatch.map(record =>
                columns.map(col => this.sanitizeValue(record[col], columnTypes.get(col) || ''))
              );
            }

            // Append each pre-sanitized row using Appender API
            for (let r = 0; r < sanitizedRows.length; r++) {
              const sanitizedRow = sanitizedRows[r];
              for (let c = 0; c < columns.length; c++) {
                const value = sanitizedRow[c];
                const mysqlType = columnTypes.get(columns[c]) || '';

                try {
                  this.appendValueByType(appender, value, mysqlType);
                } catch (appendErr: any) {
                  logger.error(`Appender column error: table=${tableName} col=${columns[c]} mysqlType=${mysqlType} value=${JSON.stringify(value)}: ${appendErr.message}`);
                  throw appendErr;
                }
              }

              appender.endRow();
            }

            recordsProcessed += fetchedBatch.length;
            if (primaryKeyColumns.length > 0) {
              const lastRecord = fetchedBatch[fetchedBatch.length - 1];
              lastStreamCursor = primaryKeyColumns.map((primaryKeyColumn) => lastRecord[primaryKeyColumn]);
            }

            // Flush appender periodically to prevent memory exhaustion
            if (recordsProcessed - lastFlushedAt >= FLUSH_INTERVAL) {
              logger.info(`${tableName}: Flushing appender at ${recordsProcessed.toLocaleString()} records to free memory...`);
              appender.flushSync();
              lastFlushedAt = recordsProcessed;

              if (fullSyncSession) {
                fullSyncSession = await this.updateFullSyncSessionProgress(fullSyncSession, lastStreamCursor, recordsProcessed);
              }

              // Force garbage collection if available (helps in low memory situations)
              if (global.gc) {
                global.gc();
                logger.debug(`${tableName}: Garbage collection triggered after flush`);
              }

              const memoryAfterFlush = process.memoryUsage();
              const rssAfterFlushMB = (memoryAfterFlush.rss / 1024 / 1024).toFixed(1);
              const heapAfterFlushMB = (memoryAfterFlush.heapUsed / 1024 / 1024).toFixed(1);
              const externalAfterFlushMB = (memoryAfterFlush.external / 1024 / 1024).toFixed(1);

              logger.info(
                `${tableName}: Appender flushed successfully, memory freed | RSS: ${rssAfterFlushMB} MB | Heap: ${heapAfterFlushMB} MB | External: ${externalAfterFlushMB} MB`
              );
            }

            // Log progress for large tables
            if (totalRecords >= PROGRESS_LOG_INTERVAL && recordsProcessed - lastLoggedAt >= PROGRESS_LOG_INTERVAL) {
              const rawPercent = (recordsProcessed / totalRecords) * 100;
              const percent = Math.min(rawPercent, 100).toFixed(1);
              const memUsage = process.memoryUsage();
              const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);
              const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
              const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(1);
              const externalMB = (memUsage.external / 1024 / 1024).toFixed(1);

              if (rawPercent > 100) {
                logger.info(
                  `${tableName}: Processing... ${recordsProcessed.toLocaleString()} records (est. ${totalRecords.toLocaleString()}) | Memory: RSS ${rssMB} MB | Heap ${heapUsedMB}/${heapTotalMB} MB | External ${externalMB} MB`
                );
              } else {
                logger.info(
                  `${tableName}: Processing... ${recordsProcessed.toLocaleString()}/${totalRecords.toLocaleString()} records (${percent}%) | Memory: RSS ${rssMB} MB | Heap ${heapUsedMB}/${heapTotalMB} MB | External ${externalMB} MB`
                );
              }
              lastLoggedAt = recordsProcessed;
            }

            logger.debug(`Appended ${fetchedBatch.length} records to ${tableName}, total: ${recordsProcessed}`);
          }

          logger.debug(`${tableName}: Flushing Appender...`);
          appender.flushSync();
          if (fullSyncSession) {
            fullSyncSession = await this.updateFullSyncSessionProgress(fullSyncSession, lastStreamCursor, recordsProcessed);
          }
          appender.closeSync();
          conn.closeSync();
          _appender = null;
          _conn = null;
          logger.info(`${tableName}: Appender flushed and closed successfully`);
        }

        if (fullSyncSession) {
          fullSyncSession = await this.updateFullSyncSessionStatus(fullSyncSession, 'swapping');
        }

        const alignedFullSyncInsertSql = await this.buildAlignedInsertSql(tableName, stagingTable, columns);
        await this.duckdb.run('BEGIN TRANSACTION');
        try {
          await this.duckdb.run(`DELETE FROM ${this.q(tableName)}`);
          await this.duckdb.run(alignedFullSyncInsertSql);
          await this.duckdb.run('COMMIT');
        } catch (swapError) {
          try {
            await this.duckdb.run('ROLLBACK');
          } catch (rollbackError) {
            logger.error(`Failed to rollback staging swap for ${tableName}:`, rollbackError);
          }
          if (fullSyncSession) {
            fullSyncSession = await this.updateFullSyncSessionStatus(
              fullSyncSession,
              'swapping',
              swapError instanceof Error ? swapError.message : String(swapError)
            );
          }
          throw swapError;
        }

        // Force CHECKPOINT to flush WAL and ensure data durability
        // Use checkpoint() to flush WAL and fail sync if durability checkpoint fails
        logger.debug(`${tableName}: Running CHECKPOINT to flush WAL...`);
        await this.duckdb.checkpoint();
        logger.info(`${tableName}: CHECKPOINT completed, data persisted successfully`);

        // Get max ID for watermark (supports both numeric and string IDs)
        const primaryKeyColumn = await this.detectPrimaryKeyColumn(tableName, schema);
        let maxId: string | number | undefined = undefined;

        if (primaryKeyColumn && recordsProcessed > 0) {
          try {
            const maxResult = await this.duckdb.execute(`SELECT MAX(${this.q(primaryKeyColumn)}) as max_id FROM ${this.q(tableName)}`);
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

        if (fullSyncSession) {
          fullSyncSession = await this.updateFullSyncSessionStatus(fullSyncSession, 'completed');
        }
        await this.dropTableIfExists(stagingTable, `post-swap cleanup for ${tableName}`);

        logger.info(`Appender-based sync completed for ${tableName}: ${recordsProcessed} records`);

      } catch (error) {
        if (_appender) { try { _appender.closeSync(); } catch {} }
        if (_conn) { try { _conn.closeSync(); } catch {} }
        if (fullSyncSession) {
          try {
            fullSyncSession = await this.updateFullSyncSessionStatus(
              fullSyncSession,
              fullSyncSession.status,
              error instanceof Error ? error.message : String(error)
            );
          } catch (sessionError) {
            logger.warn(`Failed to persist resumable full sync session state for ${tableName}:`, sessionError);
          }
        } else {
          await this.dropTableIfExists(stagingTable, `error cleanup for ${tableName}`);
        }
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

      if (resumableSessionActive) {
        logger.error(`Appender-based sync failed for ${tableName}; resumable session retained for retry:`, error);
        return {
          table: tableName,
          recordsProcessed: 0,
          duration,
          status: 'error',
          error: errorMessage,
          syncType: 'sequential'
        };
      }

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
      let lastRecord: any = null;

      // Determine streaming parameters based on watermark type
      let watermarkColumn: string;
      let watermarkValue: any;

      if (watermark.lastProcessedTimestamp && watermark.timestampColumn) {
        watermarkColumn = watermark.timestampColumn;
        watermarkValue = watermark.lastProcessedTimestamp;
        logger.info(`Streaming incremental data for ${tableName} using ${watermarkColumn} since ${watermark.lastProcessedTimestamp}`);
      } else if (watermark.lastProcessedId && watermark.primaryKeyColumn) {
        watermarkColumn = watermark.primaryKeyColumn;
        watermarkValue = watermark.lastProcessedId;
        logger.info(`Streaming incremental data for ${tableName} using ${watermarkColumn} since ID ${watermark.lastProcessedId}`);
      } else {
        // No proper watermark columns, fall back to sequential with Appender (6-10x faster)
        logger.warn(`Invalid watermark for ${tableName}, falling back to sequential sync with Appender`);
        return await this.syncTableSequentialWithAppender(tableName);
      }

      try {
        // Get column names and keys for staging-table incremental merge
        const columns = schema.map(col => col.Field);
        const columnTypes = new Map(schema.map(col => [col.Field, col.Type]));
        const primaryKeyColumns = this.getPrimaryKeyColumnsFromSchema(schema);

        if (primaryKeyColumns.length === 0) {
          logger.warn(`${tableName}: No primary key found for incremental merge, falling back to sequential sync with Appender`);
          return await this.syncTableSequentialWithAppender(tableName);
        }

        const columnCount = schema.length;
        const fetchBatchSize = config.sync.batchSize;
        const flushInterval = config.sync.appenderFlushInterval;
        let lastFlushedAt = 0;

        await this.ensureStartupStagingCleanup();
        await this.cleanupOrphanStagingTables(tableName);

        let totalBatches = 0;
        let stagingTable: string | null = null;
        let _appender: any = null;
        let _conn: any = null;

        try {
          // Stream incremental data batch-by-batch (no full dataset in memory)
          for await (const streamBatch of this.mysql.streamIncrementalData(tableName, watermarkColumn, watermarkValue, fetchBatchSize)) {
            if (streamBatch.length === 0) continue;

            if (!_appender || !_conn || !stagingTable) {
              stagingTable = this.buildStagingTableName(tableName);
              await this.createTable(stagingTable, schema, { includePrimaryKey: false });

              logger.info(`${tableName}: watermark sync - columns=${columnCount}, fetchBatchSize=${fetchBatchSize}, flushInterval=${flushInterval}, primaryKeys=${primaryKeyColumns.join(', ')}, strategy=staging-merge`);

              const { appender, connection: conn } = await this.duckdb.createAppender(stagingTable);
              _appender = appender;
              _conn = conn;
            }

            const appender = _appender;
            totalBatches++;
            const batchNumber = totalBatches;
            const sampleRecord = streamBatch[0] || {};

            // Sanitize batch: use worker threads if enabled, otherwise main thread
            let sanitizedRows: any[][];
            const pool = WorkerPool.getInstance();
            let useMainThread = pool.isDisabled;

            if (!useMainThread) {
              try {
                const columnTypesObj: Record<string, string> = {};
                for (const [k, v] of columnTypes) columnTypesObj[k] = v;
                sanitizedRows = await pool.sanitizeBatch(streamBatch, columns, columnTypesObj);
              } catch (workerErr) {
                logger.warn(`${tableName}: Worker pool sanitization failed (incremental), falling back to main thread:`, workerErr);
                useMainThread = true;
              }
            }

            if (useMainThread) {
              sanitizedRows = streamBatch.map(record =>
                columns.map(col => this.sanitizeValue(record[col], columnTypes.get(col) || ''))
              );
            }

            this.maybeLogCrashDiagnostics(`${tableName}: incremental batch prepared`, {
              batchNumber,
              batchSize: streamBatch.length,
              valuesCount: sanitizedRows.length * columns.length,
              useMainThread,
              watermarkColumn,
              watermarkValue: watermarkValue instanceof Date ? watermarkValue.toISOString() : String(watermarkValue),
              primaryKeyColumn: watermark.primaryKeyColumn || null,
              primaryKeySample: watermark.primaryKeyColumn ? this.describeDiagnosticValue(sampleRecord[watermark.primaryKeyColumn]) : null,
              timestampColumn: watermark.timestampColumn || null,
              timestampSample: watermark.timestampColumn ? this.describeDiagnosticValue(sampleRecord[watermark.timestampColumn]) : null,
              sampleValueTypes: Object.fromEntries(
                columns.slice(0, 8).map((col) => [col, this.describeDiagnosticValue(sampleRecord[col])])
              ),
            });

            this.maybeLogCrashDiagnostics(`${tableName}: incremental staging append starting`, {
              batchNumber,
              batchSize: streamBatch.length,
              valuesCount: sanitizedRows.length * columns.length,
              stagingTable,
            });

            for (const sanitizedRow of sanitizedRows) {
              for (let c = 0; c < columns.length; c++) {
                const value = sanitizedRow[c];
                const mysqlType = columnTypes.get(columns[c]) || '';
                this.appendValueByType(appender, value, mysqlType);
              }
              appender.endRow();
            }

            recordsProcessed += streamBatch.length;
            lastRecord = streamBatch[streamBatch.length - 1];

            if (recordsProcessed - lastFlushedAt >= flushInterval) {
              appender.flushSync();
              lastFlushedAt = recordsProcessed;
            }

            this.maybeLogCrashDiagnostics(`${tableName}: incremental staging append completed`, {
              batchNumber,
              batchSize: streamBatch.length,
              recordsProcessedAfterBatch: recordsProcessed,
              stagingTable,
            });

            logger.debug(`${tableName}: streamed ${recordsProcessed} incremental records so far`);
          }

          if (recordsProcessed === 0) {
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

          const appender = _appender;
          const conn = _conn;
          const activeStagingTable = stagingTable;
          if (!appender || !conn || !activeStagingTable) {
            throw new Error(`${tableName}: incremental staging state missing after streaming rows`);
          }

          appender.flushSync();
          appender.closeSync();
          conn.closeSync();
          _appender = null;
          _conn = null;

          const joinPredicate = this.buildPrimaryKeyJoinPredicate('target', 'staging', primaryKeyColumns);
          const alignedIncrementalInsertSql = await this.buildAlignedInsertSql(tableName, activeStagingTable, columns);

          await this.duckdb.run('BEGIN TRANSACTION');
          try {
            await this.duckdb.run(`DELETE FROM ${this.q(tableName)} AS target USING ${this.q(activeStagingTable)} AS staging WHERE ${joinPredicate}`);
            await this.duckdb.run(alignedIncrementalInsertSql);
            await this.duckdb.run('COMMIT');
          } catch (mergeError) {
            try {
              await this.duckdb.run('ROLLBACK');
            } catch (rollbackError) {
              logger.error(`Failed to rollback incremental staging merge for ${tableName}:`, rollbackError);
            }
            throw mergeError;
          } finally {
            await this.dropTableIfExists(activeStagingTable, `incremental staging cleanup for ${tableName}`);
          }

          // Update watermark from last record seen in stream
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
          if (_appender) { try { _appender.closeSync(); } catch {} }
          if (_conn) { try { _conn.closeSync(); } catch {} }
          if (stagingTable) {
            await this.dropTableIfExists(stagingTable, `error cleanup for incremental sync of ${tableName}`);
          }
          throw error;
        }

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
        await this.duckdb.run(`DROP VIEW IF EXISTS ${this.q(tableName)}`);
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
  private async createTable(
    tableName: string,
    schema: any[],
    options?: { includePrimaryKey?: boolean }
  ): Promise<void> {
    const includePrimaryKey = options?.includePrimaryKey ?? true;
    const primaryKeyColumns = includePrimaryKey
      ? schema.filter(col => col.Key === 'PRI').map(col => col.Field)
      : [];

    const columns = schema.map(col => {
      const type = this.mapMySQLTypeToDuckDB(col.Type);
      // Always make all columns nullable
      // MySQL often has NULL values even in NOT NULL columns due to legacy data or lenient enforcement
      // DuckDB enforces constraints strictly, so we allow NULL to prevent sync failures

      // Don't add PRIMARY KEY constraint here - we'll add it separately
      return `${this.q(col.Field)} ${type}`;
    });

    // Add composite primary key constraint if there are primary key columns
    if (primaryKeyColumns.length > 0) {
      columns.push(`PRIMARY KEY (${primaryKeyColumns.map(pk => this.q(pk)).join(', ')})`);
    }

    const createQuery = `CREATE TABLE ${this.q(tableName)} (${columns.join(', ')})`;
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
        const alterQuery = `ALTER TABLE ${this.q(tableName)} ADD COLUMN ${this.q(col.Field)} ${type}`;
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
          await this.duckdb.run(`DROP TABLE IF EXISTS ${this.q(tableName)}`);
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
        if (this.isInternalStagingTable(table)) {
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
          await this.duckdb.run(`DROP TABLE IF EXISTS ${this.q(table)}`);
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
    if (type.includes('json')) return 'JSON';
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
    if (type.includes('bit')) return 'VARCHAR';

    return 'VARCHAR';
  }

  /**
   * Detect primary key column from schema
   */
  private async detectPrimaryKeyColumn(tableName: string, schema: any[]): Promise<string | undefined> {
    // Only return a column when the table has a single-column primary key.
    // Composite primary keys are not suitable for single-column MAX() watermarks,
    // and guessing a non-PK column (e.g. 'id') creates questionable watermark behaviour.
    // Tables without a single-column PK will rely on timestamp-based watermarks instead.
    const pkColumns = schema.filter(col => col.Key === 'PRI');
    if (pkColumns.length === 1) {
      return pkColumns[0].Field;
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
