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
      multipleStatements: true,
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
   * Get all primary key columns for a table
   * Returns empty array if no primary key exists
   */
  async getPrimaryKeyColumns(tableName: string): Promise<string[]> {
    const schema = await this.getTableSchema(tableName);
    return schema.filter(col => col.Key === 'PRI').map(col => col.Field);
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
   * Falls back to OFFSET pagination if no single-column primary key exists (including composite PKs)
   */
  async *streamTableData(tableName: string, batchSize: number = 10000): AsyncGenerator<any[], void, unknown> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);

    if (primaryKey) {
      // Keyset pagination - O(1) per batch regardless of table size
      let lastId: any = null;
      let batch: any[];

      logger.info(`MySQL streamTableData for ${tableName}: batchSize=${batchSize}, using keyset pagination on '${primaryKey}'`);

      do {
        let query: string;
        let params: any[] = [];

        if (lastId === null) {
          // First batch - no WHERE clause needed
          query = `SELECT * FROM ${this.q(tableName)} ORDER BY ${this.q(primaryKey)} ASC LIMIT ${batchSize}`;
        } else {
          // Subsequent batches - use WHERE pk > lastPk
          query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(primaryKey)} > ? ORDER BY ${this.q(primaryKey)} ASC LIMIT ${batchSize}`;
          params = [lastId];
        }

        batch = await this.execute(query, params);

        if (batch.length > 0) {
          lastId = batch[batch.length - 1][primaryKey];
          yield batch;
        }
      } while (batch.length === batchSize);
    } else {
      // Fallback to OFFSET pagination for tables without single-column primary key (includes composite PKs)
      let offset = 0;
      let batch: any[];

      logger.warn(`MySQL streamTableData for ${tableName}: no single-column primary key found, falling back to OFFSET pagination (slower for large tables)`);

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
   */
  async *streamIncrementalData(
    tableName: string,
    watermarkColumn: string,
    watermarkValue: any,
    batchSize: number = 10000
  ): AsyncGenerator<any[], void, unknown> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);

    if (primaryKey) {
      // Keyset pagination using primary key for ordering within same watermark values
      let lastId: any = null;
      let lastWatermark: any = watermarkValue;
      let batch: any[];

      logger.info(`MySQL streamIncrementalData for ${tableName}: using keyset pagination on '${primaryKey}'`);

      do {
        let query: string;
        let params: any[];

        if (lastId === null) {
          // First batch
          query = `SELECT * FROM ${this.q(tableName)} WHERE ${this.q(watermarkColumn)} >= ? ORDER BY ${this.q(watermarkColumn)} ASC, ${this.q(primaryKey)} ASC LIMIT ${batchSize}`;
          params = [watermarkValue];
        } else {
          // Subsequent batches - handle tie-breaking with primary key
          query = `SELECT * FROM ${this.q(tableName)} WHERE (${this.q(watermarkColumn)} > ?) OR (${this.q(watermarkColumn)} = ? AND ${this.q(primaryKey)} > ?) ORDER BY ${this.q(watermarkColumn)} ASC, ${this.q(primaryKey)} ASC LIMIT ${batchSize}`;
          params = [lastWatermark, lastWatermark, lastId];
        }

        batch = await this.execute(query, params);

        if (batch.length > 0) {
          const lastRecord = batch[batch.length - 1];
          lastId = lastRecord[primaryKey];
          lastWatermark = lastRecord[watermarkColumn];
          yield batch;
        }
      } while (batch.length === batchSize);
    } else {
      // Fallback to OFFSET pagination
      let offset = 0;
      let batch: any[];

      logger.warn(`MySQL streamIncrementalData for ${tableName}: no single-column primary key, falling back to OFFSET pagination`);

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