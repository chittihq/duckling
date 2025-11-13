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
      dateStrings: true
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

  async getTableSchema(tableName: string): Promise<any[]> {
    return await this.execute(`DESCRIBE ${tableName}`);
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
    return result[0].count;
  }

  async getLastUpdatedTimestamp(tableName: string): Promise<Date | null> {
    try {
      const columns = await this.getTableSchema(tableName);
      const timestampColumn = columns.find(col =>
        col.Field === 'updatedAt' || col.Field === 'modifiedAt' || col.Field === 'timestamp'
      );

      if (!timestampColumn) return null;

      const result = await this.execute(
        `SELECT MAX(${timestampColumn.Field}) as max_timestamp FROM ${tableName}`
      );

      return result[0].max_timestamp || null;
    } catch (error) {
      logger.warn(`Could not get last updated timestamp for ${tableName}:`, error);
      return null;
    }
  }

  async getTableData(tableName: string, limit?: number, offset?: number): Promise<any[]> {
    let query = `SELECT * FROM ${tableName}`;
    
    if (limit) {
      // Use non-parameterized LIMIT to avoid MySQL parameter issues
      query += ` LIMIT ${parseInt(limit.toString())}`;
      
      if (offset) {
        query += ` OFFSET ${parseInt(offset.toString())}`;
      }
    }
    
    return await this.execute(query);
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

    let query = `SELECT * FROM ${tableName} WHERE ${timestampColumn.Field} >= ?`;
    const params: any[] = [lastSync];

    if (limit) {
      // Use non-parameterized LIMIT to avoid MySQL parameter issues
      query += ` LIMIT ${parseInt(limit.toString())}`;
    }

    return await this.execute(query, params);
  }

  /**
   * Stream table data in batches for sequential processing
   * Yields batches of records to avoid loading entire table into memory
   */
  async *streamTableData(tableName: string, batchSize: number = 10000): AsyncGenerator<any[], void, unknown> {
    let offset = 0;
    let batch: any[];

    do {
      batch = await this.getTableData(tableName, batchSize, offset);

      if (batch.length > 0) {
        yield batch;
        offset += batchSize;
      }
    } while (batch.length === batchSize);
  }

  /**
   * Stream incremental data based on watermark
   */
  async *streamIncrementalData(
    tableName: string,
    watermarkColumn: string,
    watermarkValue: any,
    batchSize: number = 10000
  ): AsyncGenerator<any[], void, unknown> {
    let offset = 0;
    let batch: any[];

    do {
      const query = `SELECT * FROM ${tableName} WHERE ${watermarkColumn} >= ? ORDER BY ${watermarkColumn} ASC LIMIT ${batchSize} OFFSET ${offset}`;
      batch = await this.execute(query, [watermarkValue]);

      if (batch.length > 0) {
        yield batch;
        offset += batchSize;
      }
    } while (batch.length === batchSize);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default MySQLConnection;