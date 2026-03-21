import mysql from 'mysql2/promise';
import config from '../config';
import logger from '../logger';

class MySQLConnection {
  private pool: mysql.Pool;
  private static instances: Map<string, MySQLConnection> = new Map();

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error('MySQL connection string is required');
    }

    this.pool = mysql.createPool({
      uri: connectionString,
      connectionLimit: config.mysql.maxConnections,
      timezone: 'Z',
      multipleStatements: false,
      dateStrings: true,
      charset: 'UTF8MB4_GENERAL_CI'
    });
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
  async *streamIncrementalData(
    tableName: string,
    watermarkColumn: string,
    watermarkValue: any,
    batchSize: number = 10000
  ): AsyncGenerator<any[], void, unknown> {
    const pkColumns = await this.getPrimaryKeyColumns(tableName);

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
          query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(watermarkColumn)} >= ? ORDER BY ${this.q(watermarkColumn)} ASC, ${pkOrderByClause} LIMIT ${batchSize}`;
          params = [watermarkValue];
        } else {
          // Subsequent batches - handle tie-breaking with primary key(s).
          // Fetches rows where: watermark > lastWatermark (next time-window)
          //   OR watermark = lastWatermark AND (pk tuple) > (last pk values)
          // The tuple comparison handles composite PKs correctly, paginating
          // across rows that share the same watermark value.
          const tupleCols = `(${pkColumns.map(pk => this.q(pk)).join(', ')})`;
          const tuplePlaceholders = `(${pkColumns.map(() => '?').join(', ')})`;
          query = `SELECT * FROM ${this.q(tableName)} WHERE (${this.q(watermarkColumn)} > ?) OR (${this.q(watermarkColumn)} = ? AND ${tupleCols} > ${tuplePlaceholders}) ORDER BY ${this.q(watermarkColumn)} ASC, ${pkOrderByClause} LIMIT ${batchSize}`;
          params = [lastWatermark, lastWatermark, ...lastPkValues];
        }

        batch = await this.execute(query, params);

        if (batch.length > 0) {
          const lastRecord = batch[batch.length - 1];
          lastPkValues = pkColumns.map(pk => lastRecord[pk]);
          lastWatermark = lastRecord[watermarkColumn];
          yield batch;
        }
      } while (batch.length === batchSize);
    } else {
      // Fallback to OFFSET pagination for tables without any primary key
      let offset = 0;
      let batch: any[];

      logger.warn(`MySQL streamIncrementalData for ${tableName}: no primary key, falling back to OFFSET pagination`);

      do {
        const query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(watermarkColumn)} >= ? ORDER BY ${this.q(watermarkColumn)} ASC LIMIT ${batchSize} OFFSET ${offset}`;
        batch = await this.execute(query, [watermarkValue]);

        if (batch.length > 0) {
          yield batch;
          offset += batchSize;
        }
      } while (batch.length === batchSize);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default MySQLConnection;
