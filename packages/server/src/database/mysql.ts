import mysql from 'mysql2/promise';
import config from '../config';
import logger from '../logger';

class MySQLConnection {
  private pool: mysql.Pool;
  private readonly connectionString: string;
  private static instances: Map<string, MySQLConnection> = new Map();

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error('MySQL connection string is required');
    }
    this.connectionString = connectionString;
    this.pool = this.createPool();
  }

  private createPool(): mysql.Pool {
    return mysql.createPool({
      uri: this.connectionString,
      connectionLimit: config.mysql.maxConnections,
      timezone: 'Z',
      multipleStatements: false,
      dateStrings: true,
      charset: 'UTF8MB4_GENERAL_CI'
    });
  }

  async reconnect(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      logger.warn('MySQL reconnect: pool end failed (continuing):', error);
    }
    this.pool = this.createPool();
  }

  static getInstance(databaseId: string, connectionString: string): MySQLConnection {
    if (!MySQLConnection.instances.has(databaseId)) {
      MySQLConnection.instances.set(databaseId, new MySQLConnection(connectionString));
    }
    return MySQLConnection.instances.get(databaseId)!;
  }

  static closeInstance(databaseId: string): void {
    const instance = MySQLConnection.instances.get(databaseId);
    if (instance) {
      instance.close();
      MySQLConnection.instances.delete(databaseId);
    }
  }

  async execute(query: string, params?: any[]): Promise<any> {
    try {
      const [rows] = await this.pool.execute(query, params);
      return rows;
    } catch (error) {
      logger.error('MySQL query error:', { query, error });
      throw error;
    }
  }

  async getConnection(): Promise<mysql.PoolConnection> {
    return await this.pool.getConnection();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.execute('SELECT 1');
      return true;
    } catch (error) {
      logger.error('MySQL connection test failed:', error);
      return false;
    }
  }

  /**
   * Read a single MySQL server variable. Returns the string form of the value or null
   * if the variable is unset. Uses `query()` (text protocol) instead of `execute()`
   * because some MySQL versions reject SHOW commands sent via prepared statements.
   * The variable name is whitelisted to identifier characters so it's safe to inline.
   */
  async getVariable(name: string): Promise<string | null> {
    const safeName = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safeName) return null;
    try {
      const [rows] = await this.pool.query(`SHOW VARIABLES LIKE '${safeName}'`);
      const rowArr = rows as Array<{ Variable_name?: string; Value?: string; value?: string }>;
      if (!Array.isArray(rowArr) || rowArr.length === 0) return null;
      const value = rowArr[0].Value ?? rowArr[0].value;
      return value === undefined || value === null ? null : String(value);
    } catch (error) {
      logger.warn(`MySQL getVariable failed for '${name}':`, error);
      return null;
    }
  }

  /**
   * Return the raw grant strings for the currently-authenticated user. PeerDB
   * needs REPLICATION SLAVE + REPLICATION CLIENT to read the binlog.
   */
  async getCurrentUserGrants(): Promise<string[]> {
    try {
      // `query()` (text protocol) — SHOW GRANTS via prepared statement is
      // unreliable across MySQL versions.
      const [rows] = await this.pool.query('SHOW GRANTS FOR CURRENT_USER()');
      const rowArr = rows as Array<Record<string, unknown>>;
      if (!Array.isArray(rowArr)) return [];
      return rowArr
        .map((row) => {
          const values = Object.values(row);
          return values.length > 0 ? String(values[0]) : '';
        })
        .filter(Boolean);
    } catch (error) {
      logger.warn('MySQL getCurrentUserGrants failed:', error);
      return [];
    }
  }

  /**
   * Capture the current binlog write position. With GTID enabled we record
   * the executed GTID set (preferred); otherwise we fall back to file+pos.
   * Called by the bootstrap dump *before* any read so PeerDB can resume
   * exactly where the snapshot ended.
   */
  async captureBinlogPosition(): Promise<{
    mode: 'gtid' | 'filepos';
    gtid?: string;
    file?: string;
    position?: number;
  } | null> {
    try {
      const gtidVar = await this.getVariable('gtid_mode');
      const gtidEnabled = gtidVar && /^ON/i.test(gtidVar);

      if (gtidEnabled) {
        const [rows] = await this.pool.query(`SELECT @@global.gtid_executed AS gtid`);
        const rowArr = rows as Array<{ gtid?: string }>;
        const gtid = Array.isArray(rowArr) && rowArr[0] ? String(rowArr[0].gtid || '') : '';
        if (gtid) {
          return { mode: 'gtid', gtid };
        }
      }

      // Fall back to file+position. MySQL 8.4+ renamed SHOW MASTER STATUS to
      // SHOW BINARY LOG STATUS; try the new form first, then the legacy form.
      let rows: any;
      try {
        [rows] = await this.pool.query('SHOW BINARY LOG STATUS');
      } catch {
        [rows] = await this.pool.query('SHOW MASTER STATUS');
      }
      if (Array.isArray(rows) && rows[0]) {
        const file = String((rows[0] as any).File || '');
        const position = Number((rows[0] as any).Position || 0);
        if (file) {
          return { mode: 'filepos', file, position };
        }
      }
      return null;
    } catch (error) {
      logger.warn('MySQL captureBinlogPosition failed:', error);
      return null;
    }
  }

  async getTables(): Promise<string[]> {
    const result = await this.execute('SHOW TABLES');
    const allTables = result.map((row: any) => Object.values(row)[0] as string);
    
    // Filter out excluded tables
    const filteredTables = allTables.filter(table => 
      !config.sync.excludedTables.includes(table)
    );
    
    if (filteredTables.length !== allTables.length) {
      logger.info(`Filtered out ${allTables.length - filteredTables.length} excluded tables:`, {
        excluded: config.sync.excludedTables,
        total: allTables.length,
        filtered: filteredTables.length
      });
    }
    
    return filteredTables;
  }

  async getAllTables(): Promise<string[]> {
    const result = await this.execute('SHOW TABLES');
    return result.map((row: any) => Object.values(row)[0] as string);
  }

  /** Backtick-quote a MySQL identifier, escaping embedded backticks. */
  private q(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  async getTableSchema(tableName: string): Promise<any[]> {
    return await this.execute(`DESCRIBE ${this.q(tableName)}`);
  }

  /**
   * Get all primary key columns for a table in PRIMARY KEY index order.
   * Uses SHOW INDEX to get columns ordered by SEQ_IN_INDEX, which matches
   * the actual index definition and enables index-backed keyset pagination.
   * Returns empty array if no primary key exists.
   */
  async getPrimaryKeyColumns(tableName: string): Promise<string[]> {
    const rows = await this.execute(
      `SHOW INDEX FROM ${this.q(tableName)} WHERE Key_name = 'PRIMARY'`
    );
    // Sort by Seq_in_index to guarantee correct composite-key order
    return rows
      .sort((a: any, b: any) => a.Seq_in_index - b.Seq_in_index)
      .map((row: any) => row.Column_name);
  }

  /**
   * Get the primary key column for a table (single-column PKs only)
   * Returns undefined if no primary key exists or if the primary key is composite.
   * Composite primary keys are not suitable for single-column keyset pagination.
   */
  async getPrimaryKeyColumn(tableName: string): Promise<string | undefined> {
    const pkColumns = await this.getPrimaryKeyColumns(tableName);
    return pkColumns.length === 1 ? pkColumns[0] : undefined;
  }

  /**
   * Get exact row count using COUNT(*) - SLOW for large tables
   * Use getTableRowCountFast() for progress tracking or estimates
   */
  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.execute(`SELECT COUNT(*) as count FROM ${this.q(tableName)}`);
    return result[0].count;
  }

  /**
   * Get estimated row count from information_schema - INSTANT
   * Note: For InnoDB tables, this is approximate (typically within 10-20%)
   * Perfect for progress tracking, validation estimates, and UI display
   */
  async getTableRowCountFast(tableName: string): Promise<number> {
    const result = await this.execute(`
      SELECT TABLE_ROWS as count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `, [tableName]);
    return result[0]?.count || 0;
  }

  /**
   * Get all table row counts in a single query - INSTANT
   * Returns a Map of tableName -> estimated row count
   * Much faster than calling getTableRowCountFast() N times
   */
  async getAllTableRowCountsFast(): Promise<Map<string, number>> {
    const result = await this.execute(`
      SELECT TABLE_NAME, TABLE_ROWS
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
    `);

    const counts = new Map<string, number>();
    for (const row of result) {
      counts.set(row.TABLE_NAME, row.TABLE_ROWS || 0);
    }
    return counts;
  }

  async getLastUpdatedTimestamp(tableName: string): Promise<Date | null> {
    try {
      const columns = await this.getTableSchema(tableName);
      const timestampColumn = columns.find(col =>
        col.Field === 'updatedAt' || col.Field === 'modifiedAt' || col.Field === 'timestamp'
      );

      if (!timestampColumn) return null;

      const result = await this.execute(
        `SELECT MAX(${this.q(timestampColumn.Field)}) as max_timestamp FROM ${this.q(tableName)}`
      );

      return result[0].max_timestamp || null;
    } catch (error) {
      logger.warn(`Could not get last updated timestamp for ${tableName}:`, error);
      return null;
    }
  }

  async getTableChangeToken(tableName: string): Promise<string | null> {
    try {
      const columns = await this.getTableSchema(tableName);
      const timestampColumn = columns.find(col =>
        col.Field === 'updatedAt' || col.Field === 'updated_at' ||
        col.Field === 'modifiedAt' || col.Field === 'modified_at'
      ) || columns.find(col =>
        col.Field === 'createdAt' || col.Field === 'created_at'
      ) || columns.find(col =>
        col.Field === 'timestamp'
      );

      if (!timestampColumn) return null;

      const result = await this.execute(
        `SELECT MAX(${this.q(timestampColumn.Field)}) as max_timestamp FROM ${this.q(tableName)}`
      );

      const raw = result[0]?.max_timestamp;
      return raw === null || raw === undefined ? null : String(raw);
    } catch (error) {
      logger.warn(`Could not get change token for ${tableName}:`, error);
      return null;
    }
  }

  async getTableData(tableName: string, limit?: number, offset?: number): Promise<any[]> {
    let query = `SELECT * FROM ${this.q(tableName)}`;

    if (limit) {
      // Use non-parameterized LIMIT to avoid MySQL parameter issues
      query += ` LIMIT ${parseInt(limit.toString())}`;

      if (offset) {
        query += ` OFFSET ${parseInt(offset.toString())}`;
      }
    }

    logger.info(`MySQL getTableData query: ${query}`);
    const results = await this.execute(query);
    logger.info(`MySQL getTableData returned ${results.length} rows (requested limit: ${limit})`);

    return results;
  }

  async getIncrementalData(tableName: string, lastSync: Date, limit?: number): Promise<any[]> {
    const columns = await this.getTableSchema(tableName);

    // Priority order: updatedAt (modifications) → createdAt (append-only) → timestamp (fallback)
    const timestampColumn = columns.find(col =>
      col.Field === 'updatedAt' || col.Field === 'updated_at' || col.Field === 'modifiedAt' || col.Field === 'modified_at'
    ) || columns.find(col =>
      col.Field === 'createdAt' || col.Field === 'created_at'
    ) || columns.find(col =>
      col.Field === 'timestamp'
    );

    if (!timestampColumn) {
      logger.warn(`No timestamp column found for incremental sync on ${tableName}`);
      return [];
    }

    let query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(timestampColumn.Field)} >= ?`;
    const params: any[] = [lastSync];

    if (limit) {
      // Use non-parameterized LIMIT to avoid MySQL parameter issues
      query += ` LIMIT ${parseInt(limit.toString())}`;
    }

    return await this.execute(query, params);
  }

  /**
   * Stream table data in batches for sequential processing
   * Uses keyset pagination (WHERE pk > lastPk) for O(1) performance on large tables
   * Supports composite primary keys via row-value tuple comparison: (col1, col2) > (?, ?)
   * Falls back to OFFSET pagination only if no primary key exists at all
   */
  async *streamTableData(
    tableName: string,
    batchSize: number = 10000,
    startAfter?: any[] | null
  ): AsyncGenerator<any[], void, unknown> {
    const pkColumns = await this.getPrimaryKeyColumns(tableName);

    if (pkColumns.length > 0) {
      // Keyset pagination - O(1) per batch regardless of table size
      // For composite PKs, uses MySQL row-value tuple comparison: (col1, col2) > (?, ?)
      let lastValues: any[] | null = startAfter && startAfter.length > 0 ? [...startAfter] : null;
      let batch: any[];

      const orderByClause = pkColumns.map(pk => `${this.q(pk)} ASC`).join(', ');

      logger.info(
        `MySQL streamTableData for ${tableName}: batchSize=${batchSize}, using keyset pagination on (${pkColumns.join(', ')})`
      );

      do {
        let query: string;
        let params: any[] = [];

        if (lastValues === null) {
          // First batch - no WHERE clause needed
          query = `SELECT * FROM ${this.q(tableName)} ORDER BY ${orderByClause} LIMIT ${batchSize}`;
        } else {
          // Subsequent batches - use row-value tuple comparison for keyset pagination.
          // MySQL row-value syntax: (col1, col2) > (val1, val2) compares tuples
          // lexicographically (left-to-right), equivalent to:
          //   col1 > val1 OR (col1 = val1 AND col2 > val2)
          // Requires MySQL 5.7+.  Enables O(1) keyset pagination for composite PKs.
          const tupleCols = `(${pkColumns.map(pk => this.q(pk)).join(', ')})`;
          const tuplePlaceholders = `(${pkColumns.map(() => '?').join(', ')})`;
          query = `SELECT * FROM ${this.q(tableName)} WHERE ${tupleCols} > ${tuplePlaceholders} ORDER BY ${orderByClause} LIMIT ${batchSize}`;
          params = lastValues;
        }

        batch = await this.execute(query, params);

        if (batch.length > 0) {
          const lastRecord = batch[batch.length - 1];
          lastValues = pkColumns.map(pk => lastRecord[pk]);
          yield batch;
        }
      } while (batch.length === batchSize);
    } else {
      // Fallback to OFFSET pagination for tables without any primary key
      let offset = 0;
      let batch: any[];

      logger.warn(`MySQL streamTableData for ${tableName}: no primary key found, falling back to OFFSET pagination (slower for large tables)`);

      do {
        batch = await this.getTableData(tableName, batchSize, offset);

        if (batch.length > 0) {
          yield batch;
          offset += batchSize;
        }
      } while (batch.length === batchSize);
    }
  }

  /**
   * Stream incremental data based on watermark
   * Uses keyset pagination for O(1) performance on large result sets
   * Supports composite primary keys via row-value tuple comparison for tie-breaking
   */
  private async executeWithSortMemoryRetry(
    tableName: string,
    query: string,
    params: any[],
    batchSize: number
  ): Promise<{ rows: any[]; reducedBatchSize: number | null }> {
    try {
      const rows = await this.execute(query, params);
      return { rows, reducedBatchSize: null };
    } catch (error: any) {
      if (error?.code === 'ER_OUT_OF_SORTMEMORY' || error?.errno === 1038) {
        const smallerLimit = Math.max(100, Math.floor(batchSize / 10));
        logger.warn(
          `${tableName}: sort memory exceeded with LIMIT ${batchSize}, retrying with LIMIT ${smallerLimit}`
        );
        const reducedQuery = query.replace(
          new RegExp(`LIMIT ${batchSize}$`),
          `LIMIT ${smallerLimit}`
        );
        const rows = await this.execute(reducedQuery, params);
        return { rows, reducedBatchSize: smallerLimit };
      }
      throw error;
    }
  }

  async *streamIncrementalData(
    tableName: string,
    watermarkColumn: string,
    watermarkValue: any,
    batchSize: number = 10000
  ): AsyncGenerator<any[], void, unknown> {
    const pkColumns = await this.getPrimaryKeyColumns(tableName);
    let effectiveBatchSize = batchSize;

    if (pkColumns.length > 0) {
      // Keyset pagination using primary key(s) for ordering within same watermark values
      let lastPkValues: any[] | null = null;
      let lastWatermark: any = watermarkValue;
      let batch: any[];

      const pkOrderByClause = pkColumns.map(pk => `${this.q(pk)} ASC`).join(', ');

      logger.info(`MySQL streamIncrementalData for ${tableName}: using keyset pagination on (${pkColumns.join(', ')})`);

      do {
        let query: string;
        let params: any[];

        if (lastPkValues === null) {
          // First batch
          query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(watermarkColumn)} >= ? ORDER BY ${this.q(watermarkColumn)} ASC, ${pkOrderByClause} LIMIT ${effectiveBatchSize}`;
          params = [watermarkValue];
        } else {
          // Subsequent batches - handle tie-breaking with primary key(s).
          // Fetches rows where: watermark > lastWatermark (next time-window)
          //   OR watermark = lastWatermark AND (pk tuple) > (last pk values)
          // The tuple comparison handles composite PKs correctly, paginating
          // across rows that share the same watermark value.
          const tupleCols = `(${pkColumns.map(pk => this.q(pk)).join(', ')})`;
          const tuplePlaceholders = `(${pkColumns.map(() => '?').join(', ')})`;
          query = `SELECT * FROM ${this.q(tableName)} WHERE (${this.q(watermarkColumn)} > ?) OR (${this.q(watermarkColumn)} = ? AND ${tupleCols} > ${tuplePlaceholders}) ORDER BY ${this.q(watermarkColumn)} ASC, ${pkOrderByClause} LIMIT ${effectiveBatchSize}`;
          params = [lastWatermark, lastWatermark, ...lastPkValues];
        }

        const result = await this.executeWithSortMemoryRetry(tableName, query, params, effectiveBatchSize);
        batch = result.rows;
        if (result.reducedBatchSize) {
          effectiveBatchSize = result.reducedBatchSize;
        }

        if (batch.length > 0) {
          const lastRecord = batch[batch.length - 1];
          lastPkValues = pkColumns.map(pk => lastRecord[pk]);
          lastWatermark = lastRecord[watermarkColumn];
          yield batch;
        }
      } while (batch.length === effectiveBatchSize);
    } else {
      // Fallback to OFFSET pagination for tables without any primary key
      let offset = 0;
      let batch: any[];

      logger.warn(`MySQL streamIncrementalData for ${tableName}: no primary key, falling back to OFFSET pagination`);

      do {
        const query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(watermarkColumn)} >= ? ORDER BY ${this.q(watermarkColumn)} ASC LIMIT ${effectiveBatchSize} OFFSET ${offset}`;

        const result = await this.executeWithSortMemoryRetry(tableName, query, [watermarkValue], effectiveBatchSize);
        batch = result.rows;
        if (result.reducedBatchSize) {
          effectiveBatchSize = result.reducedBatchSize;
        }

        if (batch.length > 0) {
          yield batch;
          offset += effectiveBatchSize;
        }
      } while (batch.length === effectiveBatchSize);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default MySQLConnection;
