import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import config from '../config';
import logger from '../logger';
import {
  SyncResult,
  SyncStats,
  SyncAlreadyInProgressError,
  SyncProgressStatus,
} from './syncTypes';

type TableWatermark = {
  tableName: string;
  lastProcessedId?: string | number;
  lastProcessedTimestamp?: Date | null;
  primaryKeyColumn?: string | null;
  timestampColumn?: string | null;
  updatedAt: Date;
};

type TableSyncMode = 'full' | 'incremental';

class ClickHouseSyncService extends EventEmitter {
  private static instances: Map<string, ClickHouseSyncService> = new Map();

  private readonly mysql: MySQLConnection;
  private readonly clickhouse: ClickHouseConnection;
  private readonly databaseId: string;
  private readonly activeTableLocks: Set<string> = new Set();
  private syncProgress: SyncProgressStatus = {
    inProgress: false,
    type: null,
    tablesCompleted: 0,
    tablesTotal: 0,
    currentTable: null,
    recordsProcessed: 0,
    startedAt: null,
    lastError: null,
  };
  private syncLogId = 0;

  private constructor(databaseId: string, mysql: MySQLConnection, clickhouse: ClickHouseConnection) {
    super();
    this.databaseId = databaseId;
    this.mysql = mysql;
    this.clickhouse = clickhouse;
  }

  static getInstance(databaseId: string, mysql: MySQLConnection, clickhouse: ClickHouseConnection): ClickHouseSyncService {
    if (!ClickHouseSyncService.instances.has(databaseId)) {
      ClickHouseSyncService.instances.set(
        databaseId,
        new ClickHouseSyncService(databaseId, mysql, clickhouse),
      );
    }
    return ClickHouseSyncService.instances.get(databaseId)!;
  }

  isSyncInProgress(): boolean {
    return this.activeTableLocks.size > 0;
  }

  getSyncProgress(): SyncProgressStatus {
    return { ...this.syncProgress };
  }

  async fullSync(): Promise<SyncStats> {
    return this.runSync('full');
  }

  async incrementalSync(): Promise<SyncStats> {
    return this.runSync('incremental');
  }

  async syncSingleTable(tableName: string): Promise<SyncResult> {
    if (!this.tryAcquireTableLock(tableName)) {
      throw new SyncAlreadyInProgressError();
    }

    const startedAt = Date.now();
    const schema = await this.mysql.getTableSchema(tableName);
    const watermarkColumn = this.detectTimestampColumn(schema);

    try {
      this.updateProgress({
        inProgress: true,
        type: watermarkColumn ? 'incremental' : 'full',
        currentTable: tableName,
      });

      const result = watermarkColumn
        ? await this.performIncrementalSyncForTable(tableName, schema)
        : await this.performFullSyncForTable(tableName, schema);

      return {
        table: tableName,
        recordsProcessed: result.recordsProcessed,
        duration: Date.now() - startedAt,
        status: 'success',
        syncType: watermarkColumn ? 'watermark' : 'sequential',
        watermark: {
          lastProcessedId: result.lastProcessedId,
          lastProcessedTimestamp: result.lastProcessedTimestamp ?? undefined,
          primaryKey: result.primaryKeyColumns[0],
        },
      };
    } catch (error) {
      logger.error(`ClickHouse single-table sync failed for ${tableName}:`, error);
      return {
        table: tableName,
        recordsProcessed: 0,
        duration: Date.now() - startedAt,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        syncType: watermarkColumn ? 'watermark' : 'sequential',
      };
    } finally {
      this.releaseTableLock(tableName);
      this.updateProgress({ inProgress: false, currentTable: null });
    }
  }

  async getSyncStatus(): Promise<any> {
    const watermarks = await this.clickhouse.execute(`
      SELECT table_name, last_processed_id, last_processed_timestamp, primary_key_column, timestamp_column, updated_at
      FROM appender_watermarks
      ORDER BY updated_at DESC
    `);
    const recentLogs = await this.clickhouse.execute(`
      SELECT id, table_name, sync_type, records_processed, duration_ms, status, error_message, watermark_before, watermark_after, created_at
      FROM sync_log
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const mysqlTables = await this.mysql.getTables();
    const clickhouseTables = await this.clickhouse.getTables();

    return {
      watermarks,
      recentLogs,
      tables: {
        mysql: mysqlTables.length,
        clickhouse: clickhouseTables.length,
        synced: clickhouseTables.length,
        pending: mysqlTables.filter((table) => !clickhouseTables.includes(table)).length,
      },
      timestamp: new Date().toISOString(),
    };
  }

  async validateSync(): Promise<any> {
    const tables = await this.mysql.getTables();
    const validationResults = [];

    for (const table of tables) {
      const mysqlCount = await this.mysql.getTableRowCount(table);

      try {
        const clickhouseCount = await this.clickhouse.getTableRowCount(table);
        const watermark = await this.getTableWatermark(table);

        validationResults.push({
          table,
          mysqlCount,
          clickhouseCount,
          match: mysqlCount === clickhouseCount,
          difference: mysqlCount - clickhouseCount,
          lastSync: watermark?.updatedAt || null,
          syncType: watermark?.timestampColumn ? 'watermark' : 'full',
        });
      } catch (error) {
        validationResults.push({
          table,
          mysqlCount,
          clickhouseCount: 0,
          match: false,
          difference: mysqlCount,
          error: 'Table not found in ClickHouse or query failed',
        });
      }
    }

    return {
      validationResults,
      summary: {
        totalTables: validationResults.length,
        matchingTables: validationResults.filter((result) => result.match).length,
        mismatchedTables: validationResults.filter((result) => !result.match && !result.error).length,
        errorTables: validationResults.filter((result) => result.error).length,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async runSync(mode: TableSyncMode): Promise<SyncStats> {
    const tables = await this.mysql.getTables();
    const lockedTable = tables.find((table) => this.activeTableLocks.has(table));
    if (lockedTable) {
      throw new SyncAlreadyInProgressError();
    }

    const startedAt = Date.now();
    const stats: SyncStats = {
      totalTables: tables.length,
      successfulTables: 0,
      failedTables: 0,
      totalRecords: 0,
      totalDuration: 0,
      errors: [],
      syncDetails: {
        sequential: 0,
        watermark: 0,
      },
    };

    this.syncProgress = {
      inProgress: true,
      type: mode,
      tablesCompleted: 0,
      tablesTotal: tables.length,
      currentTable: null,
      recordsProcessed: 0,
      startedAt: new Date().toISOString(),
      lastError: null,
    };
    this.emit('syncProgress');

    for (const tableName of tables) {
      if (!this.tryAcquireTableLock(tableName)) {
        throw new SyncAlreadyInProgressError();
      }

      const tableStartedAt = Date.now();

      try {
        const schema = await this.mysql.getTableSchema(tableName);
        this.updateProgress({ currentTable: tableName });

        const result = mode === 'full'
          ? await this.performFullSyncForTable(tableName, schema)
          : await this.performIncrementalSyncForTable(tableName, schema);

        stats.successfulTables += 1;
        stats.totalRecords += result.recordsProcessed;
        stats.totalDuration += Date.now() - tableStartedAt;

        if (result.timestampColumn) {
          stats.syncDetails.watermark += 1;
        } else {
          stats.syncDetails.sequential += 1;
        }

        this.updateProgress({
          tablesCompleted: this.syncProgress.tablesCompleted + 1,
          recordsProcessed: this.syncProgress.recordsProcessed + result.recordsProcessed,
        });
      } catch (error) {
        stats.failedTables += 1;
        stats.errors.push(`${tableName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        this.updateProgress({
          tablesCompleted: this.syncProgress.tablesCompleted + 1,
          lastError: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        this.releaseTableLock(tableName);
      }
    }

    stats.totalDuration = Date.now() - startedAt;
    this.syncProgress = {
      ...this.syncProgress,
      inProgress: false,
      currentTable: null,
    };
    this.emit('syncProgress');

    return stats;
  }

  private async performFullSyncForTable(tableName: string, schema: any[]): Promise<{
    recordsProcessed: number;
    lastProcessedId?: string | number;
    lastProcessedTimestamp?: Date | null;
    primaryKeyColumns: string[];
    timestampColumn: string | null;
  }> {
    const primaryKeyColumns = await this.mysql.getPrimaryKeyColumns(tableName);
    const timestampColumn = this.detectTimestampColumn(schema);
    const rawTableName = this.getRawTableName(tableName);

    await this.rebuildTable(tableName, rawTableName, schema, primaryKeyColumns);

    let recordsProcessed = 0;
    let lastProcessedId: string | number | undefined;
    let lastProcessedTimestamp: Date | null = null;
    const batchId = randomUUID();

    for await (const batch of this.mysql.streamTableData(tableName, config.sync.fullSyncBatchSize)) {
      if (batch.length === 0) continue;

      await this.clickhouse.insert(rawTableName, batch.map((row) =>
        this.serializeRow(row, schema, tableName, batchId, timestampColumn)
      ));

      recordsProcessed += batch.length;
      const lastRow = batch[batch.length - 1];
      lastProcessedId = this.extractLastProcessedId(lastRow, primaryKeyColumns);
      lastProcessedTimestamp = this.toDateOrNull(timestampColumn ? lastRow[timestampColumn] : null);
    }

    await this.saveTableWatermark({
      tableName,
      lastProcessedId,
      lastProcessedTimestamp,
      primaryKeyColumn: primaryKeyColumns[0] || null,
      timestampColumn,
    });
    await this.writeSyncLog(tableName, 'full', recordsProcessed, 'success', null);

    return {
      recordsProcessed,
      lastProcessedId,
      lastProcessedTimestamp,
      primaryKeyColumns,
      timestampColumn,
    };
  }

  private async performIncrementalSyncForTable(tableName: string, schema: any[]): Promise<{
    recordsProcessed: number;
    lastProcessedId?: string | number;
    lastProcessedTimestamp?: Date | null;
    primaryKeyColumns: string[];
    timestampColumn: string | null;
  }> {
    const primaryKeyColumns = await this.mysql.getPrimaryKeyColumns(tableName);
    const timestampColumn = this.detectTimestampColumn(schema);

    if (!timestampColumn) {
      return this.performFullSyncForTable(tableName, schema);
    }

    const rawTableName = this.getRawTableName(tableName);
    const needsBootstrap = !(await this.clickhouse.tableExists(tableName)) || !(await this.clickhouse.tableExists(rawTableName));
    if (needsBootstrap) {
      return this.performFullSyncForTable(tableName, schema);
    }

    const existingSchemaFingerprint = await this.getSchemaFingerprint(tableName);
    const nextSchemaFingerprint = this.computeSchemaFingerprint(schema);
    if (existingSchemaFingerprint && existingSchemaFingerprint !== nextSchemaFingerprint) {
      logger.info(`Schema change detected for ${tableName}; rebuilding ClickHouse structures`);
      return this.performFullSyncForTable(tableName, schema);
    }

    const watermark = await this.getTableWatermark(tableName);
    if (!watermark?.lastProcessedTimestamp) {
      return this.performFullSyncForTable(tableName, schema);
    }

    let recordsProcessed = 0;
    let lastProcessedId = watermark.lastProcessedId;
    let lastProcessedTimestamp = watermark.lastProcessedTimestamp;
    const batchId = randomUUID();

    for await (const batch of this.mysql.streamIncrementalData(
      tableName,
      timestampColumn,
      watermark.lastProcessedTimestamp,
      config.sync.batchSize,
    )) {
      if (batch.length === 0) continue;

      await this.clickhouse.insert(rawTableName, batch.map((row) =>
        this.serializeRow(row, schema, tableName, batchId, timestampColumn)
      ));

      recordsProcessed += batch.length;
      const lastRow = batch[batch.length - 1];
      lastProcessedId = this.extractLastProcessedId(lastRow, primaryKeyColumns);
      lastProcessedTimestamp = this.toDateOrNull(lastRow[timestampColumn]);
    }

    await this.saveTableWatermark({
      tableName,
      lastProcessedId,
      lastProcessedTimestamp,
      primaryKeyColumn: primaryKeyColumns[0] || null,
      timestampColumn,
    });
    await this.writeSyncLog(tableName, 'incremental', recordsProcessed, 'success', null);

    return {
      recordsProcessed,
      lastProcessedId,
      lastProcessedTimestamp,
      primaryKeyColumns,
      timestampColumn,
    };
  }

  private async rebuildTable(tableName: string, rawTableName: string, schema: any[], primaryKeyColumns: string[]): Promise<void> {
    await this.clickhouse.dropView(tableName);
    await this.clickhouse.dropTable(rawTableName);

    const physicalColumns = schema.map((column) => {
      const columnName = String(column.Field);
      const columnType = this.mapMySQLTypeToClickHouse(String(column.Type));
      return `${this.q(columnName)} ${columnType}`;
    });

    physicalColumns.push('_sync_batch_id String');
    physicalColumns.push('_sync_timestamp DateTime64(3, \'UTC\')');
    physicalColumns.push('_sync_deleted UInt8 DEFAULT 0');
    physicalColumns.push('_sync_schema_fingerprint String');

    const orderByClause = primaryKeyColumns.length > 0
      ? `(${primaryKeyColumns.map((column) => this.q(column)).join(', ')})`
      : 'tuple()';

    await this.clickhouse.run(`
      CREATE TABLE ${this.q(rawTableName)} (
        ${physicalColumns.join(',\n        ')}
      )
      ENGINE = MergeTree
      ORDER BY ${orderByClause}
      SETTINGS allow_nullable_key = 1
    `);

    await this.clickhouse.run(this.buildProjectionViewSql(tableName, rawTableName, schema, primaryKeyColumns));
  }

  private buildProjectionViewSql(tableName: string, rawTableName: string, schema: any[], primaryKeyColumns: string[]): string {
    const userColumns = schema.map((column) => this.q(String(column.Field)));
    const projection = userColumns.join(', ');

    if (primaryKeyColumns.length === 0) {
      return `
        CREATE VIEW ${this.q(tableName)} AS
        SELECT ${projection}
        FROM ${this.q(rawTableName)}
        WHERE _sync_deleted = 0
      `;
    }

    const partitionBy = primaryKeyColumns.map((column) => this.q(column)).join(', ');
    return `
      CREATE VIEW ${this.q(tableName)} AS
      SELECT ${projection}
      FROM (
        SELECT
          ${projection},
          row_number() OVER (
            PARTITION BY ${partitionBy}
            ORDER BY _sync_timestamp DESC, _sync_batch_id DESC
          ) AS _sync_row_num
        FROM ${this.q(rawTableName)}
        WHERE _sync_deleted = 0
      )
      WHERE _sync_row_num = 1
    `;
  }

  private serializeRow(
    row: Record<string, unknown>,
    schema: any[],
    tableName: string,
    batchId: string,
    timestampColumn: string | null,
  ): Record<string, unknown> {
    const serializedRow: Record<string, unknown> = {};

    for (const column of schema) {
      const field = String(column.Field);
      serializedRow[field] = this.normalizeValue(row[field], String(column.Type));
    }

    serializedRow._sync_batch_id = batchId;
    serializedRow._sync_timestamp = this.formatDateTimeValue(
      timestampColumn ? this.toDateOrNull(row[timestampColumn]) : new Date()
    );
    serializedRow._sync_deleted = 0;
    serializedRow._sync_schema_fingerprint = this.computeSchemaFingerprint(schema) + ':' + tableName;

    return serializedRow;
  }

  private normalizeValue(value: unknown, mysqlType: string): unknown {
    if (value === null || value === undefined) return null;

    const type = mysqlType.toLowerCase();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (value instanceof Date) return this.formatDateTimeValue(value);
    if (type.includes('json')) return typeof value === 'string' ? value : JSON.stringify(value);
    if (type.includes('date') || type.includes('time')) return this.formatDateTimeValue(this.toDateOrNull(value));
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }

  private formatDateTimeValue(date: Date | null): string | null {
    if (!date) return null;
    const iso = date.toISOString();
    return iso.slice(0, 23).replace('T', ' ');
  }

  private mapMySQLTypeToClickHouse(mysqlType: string): string {
    const type = mysqlType.toLowerCase();

    if (type.startsWith('tinyint(1)') || type === 'boolean' || type === 'bool') return 'Nullable(UInt8)';
    if (type.startsWith('bigint')) return type.includes('unsigned') ? 'Nullable(UInt64)' : 'Nullable(Int64)';
    if (type.startsWith('int') || type.startsWith('mediumint')) return type.includes('unsigned') ? 'Nullable(UInt32)' : 'Nullable(Int32)';
    if (type.startsWith('smallint')) return type.includes('unsigned') ? 'Nullable(UInt16)' : 'Nullable(Int16)';
    if (type.startsWith('tinyint')) return type.includes('unsigned') ? 'Nullable(UInt8)' : 'Nullable(Int8)';
    if (type.startsWith('decimal') || type.startsWith('numeric')) return 'Nullable(Decimal(38, 10))';
    if (type.startsWith('float')) return 'Nullable(Float32)';
    if (type.startsWith('double')) return 'Nullable(Float64)';
    if (type.startsWith('date')) return 'Nullable(DateTime64(3, \'UTC\'))';
    if (type.startsWith('timestamp') || type.startsWith('datetime') || type.startsWith('time')) return 'Nullable(DateTime64(3, \'UTC\'))';
    if (type.includes('blob') || type.includes('binary') || type.includes('varbinary')) return 'Nullable(String)';
    return 'Nullable(String)';
  }

  private detectTimestampColumn(schema: any[]): string | null {
    const columns = schema.map((column) => String(column.Field));
    return columns.find((field) =>
      field === 'updatedAt' || field === 'updated_at' || field === 'modifiedAt' || field === 'modified_at'
    ) || columns.find((field) =>
      field === 'createdAt' || field === 'created_at'
    ) || columns.find((field) =>
      field === 'timestamp'
    ) || null;
  }

  private async saveTableWatermark({
    tableName,
    lastProcessedId,
    lastProcessedTimestamp,
    primaryKeyColumn,
    timestampColumn,
  }: {
    tableName: string;
    lastProcessedId?: string | number;
    lastProcessedTimestamp?: Date | null;
    primaryKeyColumn?: string | null;
    timestampColumn?: string | null;
  }): Promise<void> {
    await this.clickhouse.insert('appender_watermarks', [{
      table_name: tableName,
      last_processed_id: lastProcessedId != null ? String(lastProcessedId) : null,
      last_processed_timestamp: this.formatDateTimeValue(lastProcessedTimestamp ?? null),
      primary_key_column: primaryKeyColumn ?? null,
      timestamp_column: timestampColumn ?? null,
      updated_at: this.formatDateTimeValue(new Date()),
    }]);
  }

  private async getTableWatermark(tableName: string): Promise<TableWatermark | null> {
    const rows = await this.clickhouse.execute(`
      SELECT table_name, last_processed_id, last_processed_timestamp, primary_key_column, timestamp_column, updated_at
      FROM appender_watermarks
      WHERE table_name = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `, [tableName]);

    const row = rows[0];
    if (!row || typeof row.table_name !== 'string') return null;

    return {
      tableName: row.table_name,
      lastProcessedId: row.last_processed_id != null ? String(row.last_processed_id) : undefined,
      lastProcessedTimestamp: this.toDateOrNull(row.last_processed_timestamp),
      primaryKeyColumn: row.primary_key_column != null ? String(row.primary_key_column) : null,
      timestampColumn: row.timestamp_column != null ? String(row.timestamp_column) : null,
      updatedAt: this.toDateOrNull(row.updated_at) || new Date(),
    };
  }

  private async writeSyncLog(
    tableName: string,
    syncType: 'full' | 'incremental',
    recordsProcessed: number,
    status: 'success' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    this.syncLogId += 1;
    const now = new Date();
    await this.clickhouse.insert('sync_log', [{
      id: Date.now() * 1000 + this.syncLogId,
      table_name: tableName,
      sync_type: syncType,
      records_processed: recordsProcessed,
      duration_ms: 0,
      status,
      error_message: errorMessage,
      watermark_before: null,
      watermark_after: null,
      created_at: this.formatDateTimeValue(now),
    }]);
  }

  private async getSchemaFingerprint(tableName: string): Promise<string | null> {
    const rawTableName = this.getRawTableName(tableName);
    if (!(await this.clickhouse.tableExists(rawTableName))) return null;

    const rows = await this.clickhouse.execute(`
      SELECT _sync_schema_fingerprint
      FROM ${this.q(rawTableName)}
      LIMIT 1
    `);
    const rawValue = rows[0]?._sync_schema_fingerprint;
    if (typeof rawValue !== 'string') return null;
    const [fingerprint] = rawValue.split(':');
    return fingerprint || null;
  }

  private extractLastProcessedId(row: Record<string, any>, primaryKeyColumns: string[]): string | number | undefined {
    if (primaryKeyColumns.length === 0) return undefined;
    if (primaryKeyColumns.length === 1) return row[primaryKeyColumns[0]];
    return JSON.stringify(primaryKeyColumns.map((column) => row[column]));
  }

  private computeSchemaFingerprint(schema: any[]): string {
    const normalizedSchema = schema.map((column) => ({
      field: String(column.Field),
      type: String(column.Type),
      key: String(column.Key || ''),
      nullable: String(column.Null || ''),
    }));
    return createHash('sha256').update(JSON.stringify(normalizedSchema)).digest('hex');
  }

  private updateProgress(partial: Partial<SyncProgressStatus>): void {
    this.syncProgress = {
      ...this.syncProgress,
      ...partial,
    };
    this.emit('syncProgress');
  }

  private tryAcquireTableLock(tableName: string): boolean {
    if (this.activeTableLocks.has(tableName)) {
      return false;
    }
    this.activeTableLocks.add(tableName);
    return true;
  }

  private releaseTableLock(tableName: string): void {
    this.activeTableLocks.delete(tableName);
  }

  private toDateOrNull(value: unknown): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private getRawTableName(tableName: string): string {
    return `${tableName}__raw`;
  }

  private q(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }
}

export default ClickHouseSyncService;
