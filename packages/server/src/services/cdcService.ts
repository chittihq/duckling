/**
 * CDC (Change Data Capture) Service
 *
 * Real-time MySQL to DuckDB replication using binlog streaming.
 * Uses @vlasky/zongji for MySQL binlog parsing.
 *
 * Features:
 * - Real-time INSERT, UPDATE, DELETE replication
 * - Binlog position tracking for resume capability
 * - Auto-reconnect on disconnect
 * - Multi-database support
 * - Graceful error handling
 */

import ZongJi from '@vlasky/zongji';
import logger from '../logger';
import DuckDBConnection from '../database/duckdb';
import { DatabaseConfigManager } from '../database/databaseConfig';

interface BinlogPosition {
  filename: string;
  position: number;
  timestamp: Date;
}

interface CDCConfig {
  databaseId: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlDatabase: string;
  includeTables?: string[];
  excludeTables?: string[];
}

interface CDCStats {
  isRunning: boolean;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  eventsProcessed: number;
  insertsProcessed: number;
  updatesProcessed: number;
  deletesProcessed: number;
  errors: number;
  currentPosition: BinlogPosition | null;
}

export class CDCService {
  private static instances: Map<string, CDCService> = new Map();

  private databaseId: string;
  private config: CDCConfig;
  private zongji: ZongJi | null = null;
  private duckdb: DuckDBConnection;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private stats: CDCStats;
  private tableSchemas: Map<string, Map<string, string>> = new Map(); // tableName -> columnName -> type

  constructor(config: CDCConfig) {
    this.databaseId = config.databaseId;
    this.config = config;

    // Get DuckDB connection for this database
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(config.databaseId);
    if (!dbConfig) {
      throw new Error(`Database config not found for: ${config.databaseId}`);
    }
    this.duckdb = DuckDBConnection.getInstance(config.databaseId, dbConfig.duckdbPath);

    this.stats = {
      isRunning: false,
      connectedAt: null,
      lastEventAt: null,
      eventsProcessed: 0,
      insertsProcessed: 0,
      updatesProcessed: 0,
      deletesProcessed: 0,
      errors: 0,
      currentPosition: null
    };
  }

  /**
   * Get or create CDC service instance for a database
   */
  static getInstance(databaseId: string): CDCService | null {
    return CDCService.instances.get(databaseId) || null;
  }

  /**
   * Create and register a new CDC service instance
   */
  static createInstance(config: CDCConfig): CDCService {
    if (CDCService.instances.has(config.databaseId)) {
      const existing = CDCService.instances.get(config.databaseId)!;
      existing.stop();
    }

    const instance = new CDCService(config);
    CDCService.instances.set(config.databaseId, instance);
    return instance;
  }

  /**
   * Parse MySQL connection string to extract CDC config
   */
  static parseConnectionString(connectionString: string, databaseId: string): CDCConfig {
    const url = new URL(connectionString);
    return {
      databaseId,
      mysqlHost: url.hostname,
      mysqlPort: parseInt(url.port) || 3306,
      mysqlUser: url.username,
      mysqlPassword: url.password,
      mysqlDatabase: url.pathname.replace('/', '').split('?')[0]
    };
  }

  /**
   * Initialize binlog position tracking table
   */
  private async initPositionTable(): Promise<void> {
    await this.duckdb.run(`
      CREATE TABLE IF NOT EXISTS cdc_binlog_position (
        database_id VARCHAR PRIMARY KEY,
        filename VARCHAR NOT NULL,
        position BIGINT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Get last saved binlog position
   */
  private async getLastPosition(): Promise<BinlogPosition | null> {
    try {
      const result = await this.duckdb.execute(
        'SELECT filename, position, updated_at FROM cdc_binlog_position WHERE database_id = ?',
        [this.databaseId]
      );

      if (result.length > 0) {
        return {
          filename: result[0].filename,
          position: Number(result[0].position),
          timestamp: new Date(result[0].updated_at)
        };
      }
      return null;
    } catch (error) {
      logger.warn(`Failed to get last binlog position for ${this.databaseId}:`, error);
      return null;
    }
  }

  /**
   * Save current binlog position
   */
  private async savePosition(filename: string, position: number): Promise<void> {
    try {
      await this.duckdb.run(`
        INSERT OR REPLACE INTO cdc_binlog_position (database_id, filename, position, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `, [this.databaseId, filename, position]);

      this.stats.currentPosition = {
        filename,
        position,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error(`Failed to save binlog position for ${this.databaseId}:`, error);
    }
  }

  /**
   * Cache table schema for column mapping
   */
  private async cacheTableSchema(tableName: string): Promise<void> {
    if (this.tableSchemas.has(tableName)) {
      return;
    }

    try {
      const columns = await this.duckdb.execute(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'main' AND table_name = ?
        ORDER BY ordinal_position
      `, [tableName]);

      const schemaMap = new Map<string, string>();
      for (const col of columns) {
        schemaMap.set(col.column_name, col.data_type);
      }
      this.tableSchemas.set(tableName, schemaMap);

      logger.debug(`Cached schema for table ${tableName}: ${columns.length} columns`);
    } catch (error) {
      logger.warn(`Failed to cache schema for ${tableName}:`, error);
    }
  }

  /**
   * Check if table should be processed
   */
  private shouldProcessTable(tableName: string): boolean {
    // Check exclude list
    if (this.config.excludeTables?.includes(tableName)) {
      return false;
    }

    // Check include list (if specified)
    if (this.config.includeTables && this.config.includeTables.length > 0) {
      return this.config.includeTables.includes(tableName);
    }

    // Skip internal tables
    if (['cdc_binlog_position', 'appender_watermarks', 'sync_log'].includes(tableName)) {
      return false;
    }

    return true;
  }

  /**
   * Handle INSERT event
   */
  private async handleInsert(tableName: string, rows: any[]): Promise<void> {
    if (!this.shouldProcessTable(tableName)) return;

    await this.cacheTableSchema(tableName);
    const schema = this.tableSchemas.get(tableName);

    if (!schema || schema.size === 0) {
      logger.warn(`No schema found for table ${tableName}, skipping INSERT`);
      return;
    }

    try {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map(col => this.sanitizeValue(row[col]));
        const placeholders = columns.map(() => '?').join(', ');

        const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
        await this.duckdb.run(query, values);
      }

      this.stats.insertsProcessed += rows.length;
      logger.debug(`CDC INSERT: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC INSERT failed for ${tableName}:`, error);
    }
  }

  /**
   * Handle UPDATE event
   */
  private async handleUpdate(tableName: string, rows: any[]): Promise<void> {
    if (!this.shouldProcessTable(tableName)) return;

    await this.cacheTableSchema(tableName);
    const schema = this.tableSchemas.get(tableName);

    if (!schema || schema.size === 0) {
      logger.warn(`No schema found for table ${tableName}, skipping UPDATE`);
      return;
    }

    try {
      for (const row of rows) {
        // row.after contains the new values
        const afterRow = row.after || row;
        const columns = Object.keys(afterRow);
        const values = columns.map(col => this.sanitizeValue(afterRow[col]));
        const placeholders = columns.map(() => '?').join(', ');

        // Use INSERT OR REPLACE for upsert behavior
        const query = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
        await this.duckdb.run(query, values);
      }

      this.stats.updatesProcessed += rows.length;
      logger.debug(`CDC UPDATE: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC UPDATE failed for ${tableName}:`, error);
    }
  }

  /**
   * Handle DELETE event
   */
  private async handleDelete(tableName: string, rows: any[]): Promise<void> {
    if (!this.shouldProcessTable(tableName)) return;

    await this.cacheTableSchema(tableName);

    try {
      for (const row of rows) {
        // Try to find primary key column
        const pkColumn = this.findPrimaryKeyColumn(tableName, row);

        if (pkColumn && row[pkColumn] !== undefined) {
          const query = `DELETE FROM ${tableName} WHERE ${pkColumn} = ?`;
          await this.duckdb.run(query, [row[pkColumn]]);
        } else {
          // Fallback: delete by all columns (exact match)
          const columns = Object.keys(row);
          const conditions = columns.map(col => `${col} = ?`).join(' AND ');
          const values = columns.map(col => this.sanitizeValue(row[col]));

          const query = `DELETE FROM ${tableName} WHERE ${conditions}`;
          await this.duckdb.run(query, values);
        }
      }

      this.stats.deletesProcessed += rows.length;
      logger.debug(`CDC DELETE: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC DELETE failed for ${tableName}:`, error);
    }
  }

  /**
   * Find primary key column for a table
   */
  private findPrimaryKeyColumn(tableName: string, row: any): string | null {
    const columns = Object.keys(row);

    // Common primary key patterns
    const pkPatterns = [
      'id',
      `${tableName.toLowerCase()}id`,
      `${tableName.toLowerCase()}_id`,
      tableName.charAt(0).toLowerCase() + tableName.slice(1) + 'Id'
    ];

    for (const pattern of pkPatterns) {
      const match = columns.find(col => col.toLowerCase() === pattern.toLowerCase());
      if (match) return match;
    }

    // Check for columns ending with 'Id' or '_id'
    const idColumn = columns.find(col =>
      col.endsWith('Id') || col.endsWith('_id') || col === 'id'
    );

    return idColumn || null;
  }

  /**
   * Sanitize value for DuckDB insertion
   */
  private sanitizeValue(value: any): any {
    if (value === undefined) return null;
    if (value === null) return null;

    // Handle Date objects
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle Buffer (BLOB)
    if (Buffer.isBuffer(value)) {
      return value;
    }

    // Handle BigInt
    if (typeof value === 'bigint') {
      return value.toString();
    }

    // Handle objects (JSON)
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return value;
  }

  /**
   * Start CDC streaming
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`CDC already running for ${this.databaseId}`);
      return;
    }

    logger.info(`Starting CDC service for ${this.databaseId}...`);

    try {
      // Initialize position tracking
      await this.initPositionTable();

      // Get last position for resume
      const lastPosition = await this.getLastPosition();

      // Create zongji instance
      this.zongji = new ZongJi({
        host: this.config.mysqlHost,
        port: this.config.mysqlPort,
        user: this.config.mysqlUser,
        password: this.config.mysqlPassword,
        // SSL for DigitalOcean managed MySQL
        ssl: {
          rejectUnauthorized: false
        }
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Start options
      const startOptions: any = {
        includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows'],
        includeSchema: {
          [this.config.mysqlDatabase]: true
        }
      };

      // Resume from last position if available
      if (lastPosition) {
        startOptions.filename = lastPosition.filename;
        startOptions.position = lastPosition.position;
        logger.info(`Resuming CDC from position: ${lastPosition.filename}:${lastPosition.position}`);
      } else {
        startOptions.startAtEnd = true;
        logger.info(`Starting CDC from current binlog position`);
      }

      // Start streaming
      this.zongji.start(startOptions);

      this.isRunning = true;
      this.stats.isRunning = true;
      this.stats.connectedAt = new Date();
      this.reconnectAttempts = 0;

      logger.info(`CDC service started for ${this.databaseId}`);
    } catch (error) {
      logger.error(`Failed to start CDC for ${this.databaseId}:`, error);
      this.scheduleReconnect();
    }
  }

  /**
   * Set up zongji event handlers
   */
  private setupEventHandlers(): void {
    if (!this.zongji) return;

    // Ready event
    this.zongji.on('ready', () => {
      logger.info(`CDC connected to MySQL binlog for ${this.databaseId}`);
    });

    // Binlog event
    this.zongji.on('binlog', async (event: any) => {
      try {
        this.stats.eventsProcessed++;
        this.stats.lastEventAt = new Date();

        const eventName = event.getTypeName();

        // Save position periodically (every 100 events or on important events)
        if (event.nextPosition && (this.stats.eventsProcessed % 100 === 0 ||
            ['WriteRows', 'UpdateRows', 'DeleteRows'].includes(eventName))) {
          await this.savePosition(
            event.binlogName || 'mysql-bin.000001',
            event.nextPosition
          );
        }

        // Handle row events
        if (event.tableMap && event.tableMap[event.tableId]) {
          const tableInfo = event.tableMap[event.tableId];
          const tableName = tableInfo.tableName;
          const database = tableInfo.parentSchema;

          // Only process events for our database
          if (database !== this.config.mysqlDatabase) {
            return;
          }

          switch (eventName) {
            case 'WriteRows':
              await this.handleInsert(tableName, event.rows);
              break;
            case 'UpdateRows':
              await this.handleUpdate(tableName, event.rows);
              break;
            case 'DeleteRows':
              await this.handleDelete(tableName, event.rows);
              break;
          }
        }
      } catch (error) {
        this.stats.errors++;
        logger.error(`CDC event processing error for ${this.databaseId}:`, error);
      }
    });

    // Error event
    this.zongji.on('error', (error: Error) => {
      this.stats.errors++;
      logger.error(`CDC error for ${this.databaseId}:`, error);
      this.scheduleReconnect();
    });

    // Stopped event
    this.zongji.on('stopped', () => {
      logger.warn(`CDC stopped for ${this.databaseId}`);
      this.isRunning = false;
      this.stats.isRunning = false;
    });
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`CDC max reconnect attempts reached for ${this.databaseId}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    logger.info(`CDC reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        this.stop();
        await this.start();
      } catch (error) {
        logger.error(`CDC reconnect failed for ${this.databaseId}:`, error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Stop CDC streaming
   */
  stop(): void {
    if (this.zongji) {
      try {
        this.zongji.stop();
      } catch (error) {
        logger.warn(`Error stopping zongji for ${this.databaseId}:`, error);
      }
      this.zongji = null;
    }

    this.isRunning = false;
    this.stats.isRunning = false;
    logger.info(`CDC service stopped for ${this.databaseId}`);
  }

  /**
   * Get CDC statistics
   */
  getStats(): CDCStats {
    return { ...this.stats };
  }

  /**
   * Check if CDC is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      ...this.stats,
      eventsProcessed: 0,
      insertsProcessed: 0,
      updatesProcessed: 0,
      deletesProcessed: 0,
      errors: 0
    };
  }

  /**
   * Stop all CDC instances
   */
  static stopAll(): void {
    for (const [databaseId, instance] of CDCService.instances) {
      logger.info(`Stopping CDC for ${databaseId}`);
      instance.stop();
    }
    CDCService.instances.clear();
  }

  /**
   * Get all CDC instances
   */
  static getAllInstances(): Map<string, CDCService> {
    return CDCService.instances;
  }
}

export default CDCService;
