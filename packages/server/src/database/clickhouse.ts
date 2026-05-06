import { createClient, type ClickHouseClient, type DataFormat } from '@clickhouse/client';
import config from '../config';
import logger from '../logger';

type JsonRow = Record<string, unknown>;

type JsonResult = {
  data?: JsonRow[];
  meta?: Array<{ name: string; type: string }>;
};

class ClickHouseConnection {
  private static instances: Map<string, ClickHouseConnection> = new Map();
  private static initializedInstances: Set<string> = new Set();

  private readonly databaseId: string;
  private readonly databaseName: string;
  private readonly client: ClickHouseClient;
  private readonly adminClient: ClickHouseClient;
  private initializationPromise: Promise<void> | null = null;

  private constructor(databaseId: string, databaseName: string) {
    this.databaseId = databaseId;
    this.databaseName = databaseName;
    this.adminClient = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.username,
      password: config.clickhouse.password,
    });
    this.client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.username,
      password: config.clickhouse.password,
      database: databaseName,
    });
  }

  static getInstance(databaseId: string = 'default', databaseName?: string): ClickHouseConnection {
    if (!ClickHouseConnection.instances.has(databaseId)) {
      const resolvedDatabase = databaseName || config.clickhouse.database;
      ClickHouseConnection.instances.set(
        databaseId,
        new ClickHouseConnection(databaseId, resolvedDatabase),
      );
    }
    return ClickHouseConnection.instances.get(databaseId)!;
  }

  static async closeInstance(databaseId: string): Promise<void> {
    const instance = ClickHouseConnection.instances.get(databaseId);
    if (!instance) return;

    await instance.close();
    ClickHouseConnection.instances.delete(databaseId);
    ClickHouseConnection.initializedInstances.delete(databaseId);
  }

  getDatabaseName(): string {
    return this.databaseName;
  }

  resetInitialized(): void {
    ClickHouseConnection.initializedInstances.delete(this.databaseId);
    this.initializationPromise = null;
  }

  async initializeDatabase(): Promise<void> {
    if (ClickHouseConnection.initializedInstances.has(this.databaseId)) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.doInitialize().then(() => {
        ClickHouseConnection.initializedInstances.add(this.databaseId);
      }).catch((error) => {
        this.initializationPromise = null;
        throw error;
      });
    }

    await this.initializationPromise;
  }

  private async doInitialize(): Promise<void> {
    await this.adminClient.command({
      query: `CREATE DATABASE IF NOT EXISTS ${this.q(this.databaseName)}`,
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    });

    await this.runRaw(`
      CREATE TABLE IF NOT EXISTS ${this.q('appender_watermarks')} (
        table_name String,
        last_processed_id Nullable(String),
        last_processed_timestamp Nullable(DateTime64(3, 'UTC')),
        primary_key_column Nullable(String),
        timestamp_column Nullable(String),
        updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY table_name
    `);

    await this.runRaw(`
      CREATE TABLE IF NOT EXISTS ${this.q('sync_log')} (
        id UInt64,
        table_name String,
        sync_type String,
        records_processed Int64,
        duration_ms Int64,
        status String,
        error_message Nullable(String),
        watermark_before Nullable(String),
        watermark_after Nullable(String),
        created_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = MergeTree
      ORDER BY (table_name, created_at, id)
    `);

    await this.runRaw(`
      CREATE TABLE IF NOT EXISTS ${this.q('full_sync_sessions')} (
        table_name String,
        session_id String,
        staging_table String,
        status String,
        pk_columns_json String,
        last_pk_cursor_json Nullable(String),
        records_processed UInt64 DEFAULT 0,
        schema_fingerprint String,
        error_message Nullable(String),
        started_at DateTime64(3, 'UTC'),
        updated_at DateTime64(3, 'UTC'),
        completed_at Nullable(DateTime64(3, 'UTC'))
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY table_name
    `);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.client.close(),
      this.adminClient.close(),
    ]);
  }

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.client.ping({ select: true });
      return result.success;
    } catch (error) {
      logger.error(`ClickHouse connection test failed for ${this.databaseName}:`, error);
      return false;
    }
  }

  async query(sql: string, params?: any[]): Promise<JsonRow[]> {
    return this.execute(sql, params);
  }

  async execute(sql: string, params?: any[]): Promise<JsonRow[]> {
    await this.initializeDatabase();
    const rendered = this.applyParams(sql, params);
    const resultSet = await this.client.query({
      query: rendered,
      format: 'JSONEachRow',
    });
    const rows = await resultSet.json();
    return Array.isArray(rows) ? rows as JsonRow[] : [];
  }

  async executeWithMetadata(sql: string, params?: any[]): Promise<{ rows: any[][]; columnNames: string[]; columnTypes: string[] }> {
    await this.initializeDatabase();
    const rendered = this.applyParams(sql, params);
    const resultSet = await this.client.query({
      query: rendered,
      format: 'JSON',
    });
    const payload = await resultSet.json() as JsonResult;
    const columnNames = (payload.meta || []).map((column) => column.name);
    const columnTypes = (payload.meta || []).map((column) => column.type);
    const rows = (payload.data || []).map((row) => columnNames.map((columnName) => row[columnName]));
    return { rows, columnNames, columnTypes };
  }

  async run(sql: string, params?: any[]): Promise<void> {
    await this.initializeDatabase();
    await this.runRaw(this.applyParams(sql, params));
  }

  async insert<T extends JsonRow>(table: string, rows: T[], columns?: string[]): Promise<void> {
    await this.initializeDatabase();
    if (rows.length === 0) return;

    await this.client.insert({
      table,
      values: rows,
      format: 'JSONEachRow' as DataFormat,
      columns: columns && columns.length > 0 ? columns as [string, ...string[]] : undefined,
    });
  }

  private async runRaw(sql: string): Promise<void> {
    await this.client.command({
      query: sql,
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    });
  }

  async getTables(): Promise<string[]> {
    const rows = await this.execute(`
      SELECT name, engine
      FROM system.tables
      WHERE database = ${this.escapeValue(this.databaseName)}
        AND is_temporary = 0
      ORDER BY name
    `);
    const visibleNames = new Set<string>();

    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name : null;
      if (!name) continue;
      if (this.isInternalObject(name)) continue;
      if (name.endsWith('__raw')) continue;
      visibleNames.add(name);
    }

    return Array.from(visibleNames).sort();
  }

  async getAllObjectNames(): Promise<string[]> {
    const rows = await this.execute(`
      SELECT name
      FROM system.tables
      WHERE database = ${this.escapeValue(this.databaseName)}
      ORDER BY name
    `);
    return rows
      .map((row) => (typeof row.name === 'string' ? row.name : null))
      .filter((value): value is string => Boolean(value));
  }

  async getTableSchema(tableName: string): Promise<JsonRow[]> {
    return this.execute(`DESCRIBE TABLE ${this.q(tableName)}`);
  }

  async tableExists(tableName: string): Promise<boolean> {
    const rows = await this.execute(
      `SELECT count() AS count FROM system.tables WHERE database = ${this.escapeValue(this.databaseName)} AND name = ${this.escapeValue(tableName)}`
    );
    return Number(rows[0]?.count || 0) > 0;
  }

  async dropTable(tableName: string): Promise<void> {
    await this.run(`DROP TABLE IF EXISTS ${this.q(tableName)}`);
  }

  async dropView(tableName: string): Promise<void> {
    await this.run(`DROP VIEW IF EXISTS ${this.q(tableName)}`);
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const rows = await this.execute(`SELECT count() AS count FROM ${this.q(tableName)}`);
    const raw = rows[0]?.count;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') return Number(raw);
    if (typeof raw === 'bigint') return Number(raw);
    return 0;
  }

  private q(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  private isInternalObject(name: string): boolean {
    return (
      name === 'appender_watermarks' ||
      name === 'sync_log' ||
      name === 'full_sync_sessions'
    );
  }

  private applyParams(query: string, params?: any[]): string {
    if (!params || params.length === 0) {
      return query;
    }

    let index = 0;
    const rendered = query.replace(/\?/g, () => {
      if (index >= params.length) {
        throw new Error('Not enough parameters provided for ClickHouse query');
      }
      const value = this.escapeValue(params[index]);
      index += 1;
      return value;
    });

    if (index !== params.length) {
      throw new Error('Too many parameters provided for ClickHouse query');
    }

    return rendered;
  }

  private escapeValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
    if (Buffer.isBuffer(value)) return `unhex('${value.toString('hex')}')`;
    if (Array.isArray(value)) return `[${value.map((item) => this.escapeValue(item)).join(', ')}]`;

    if (typeof value === 'object') {
      return this.escapeValue(JSON.stringify(value));
    }

    return `'${String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')}'`;
  }
}

export default ClickHouseConnection;
