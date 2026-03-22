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
import { WorkerPool } from '../workers/workerPool';
import appConfig from '../config';

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
  queueSize: number;
  queueHighWaterMark: number;
}

export class CDCService {
  private static instances: Map<string, CDCService> = new Map();

  private databaseId: string;
  private config: CDCConfig;
  private zongji: ZongJi | null = null;
  private duckdb: DuckDBConnection;
  private isRunning: boolean = false;
  private isStopped: boolean = false; // Flag to prevent reconnect after explicit stop
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private reconnectTimeoutId: NodeJS.Timeout | null = null; // Track pending reconnect
  private stats: CDCStats;
  private tableSchemas: Map<string, Map<string, string>> = new Map(); // tableName -> columnName -> type
  private currentBinlogFilename: string | null = null;
  private workerPool: WorkerPool;

  // Event queue for serialized processing (EventEmitter doesn't await async handlers)
  private eventQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;
  private queueDrainPromise: Promise<void> | null = null;
  private queueDrainResolve: (() => void) | null = null;

  // Backpressure: pause binlog stream when queue exceeds limit
  private readonly maxQueueSize: number;
  private isPaused: boolean = false;
  private backpressureAvailable: boolean = false; // Set true once pause/resume verified
  private readonly criticalQueueMultiplier: number = 2; // Force reconnect at 2× maxQueueSize

  constructor(config: CDCConfig) {
    this.databaseId = config.databaseId;
    this.config = config;

    // Get DuckDB connection for this database
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(config.databaseId);
    if (!dbConfig) {
      throw new Error(`Database config not found for: ${config.databaseId}`);
    }
    this.duckdb = DuckDBConnection.getInstance(config.databaseId, dbConfig.duckdbPath);
    this.maxQueueSize = appConfig.cdc.maxQueueSize;
    this.workerPool = WorkerPool.getInstance();

    this.stats = {
      isRunning: false,
      connectedAt: null,
      lastEventAt: null,
      eventsProcessed: 0,
      insertsProcessed: 0,
      updatesProcessed: 0,
      deletesProcessed: 0,
      errors: 0,
      currentPosition: null,
      queueSize: 0,
      queueHighWaterMark: 0
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
  static async createInstance(config: CDCConfig): Promise<CDCService> {
    if (CDCService.instances.has(config.databaseId)) {
      const existing = CDCService.instances.get(config.databaseId)!;
      await existing.stop();
    }

    const instance = new CDCService(config);
    CDCService.instances.set(config.databaseId, instance);
    return instance;
  }

  /**
   * Parse MySQL connection string to extract CDC config
   */
  static parseConnectionString(connectionString: string, databaseId: string): CDCConfig {
    try {
      const url = new URL(connectionString);

      // Validate required components
      if (!url.hostname) {
        throw new Error('Missing hostname');
      }
      if (!url.username) {
        throw new Error('Missing username');
      }
      if (!url.pathname || url.pathname === '/') {
        throw new Error('Missing database name');
      }

      return {
        databaseId,
        mysqlHost: url.hostname,
        mysqlPort: parseInt(url.port) || 3306,
        mysqlUser: url.username,
        mysqlPassword: url.password,
        mysqlDatabase: url.pathname.replace('/', '').split('?')[0]
      };
    } catch (error) {
      throw new Error(`Invalid MySQL connection string format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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

      this.currentBinlogFilename = filename;
      this.stats.currentPosition = {
        filename,
        position,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error(`Failed to save binlog position for ${this.databaseId}:`, error);
      throw error;
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
      logger.error(`Failed to cache schema for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Quote SQL identifier to prevent syntax errors with reserved words/special chars
   */
  private q(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Pause the underlying binlog connection to apply backpressure.
   * Tries connection.pause() first (mysql library level), then falls back
   * to connection.stream.pause() (raw TCP socket level).
   * Returns true if pause succeeded via either method.
   */
  private pauseBinlogStream(): boolean {
    const conn = (this.zongji as any)?.connection;
    try {
      if (typeof conn?.pause === 'function') {
        conn.pause();
        return true;
      }
      // Fallback: pause the raw TCP socket directly
      if (typeof conn?.stream?.pause === 'function') {
        conn.stream.pause();
        logger.debug(`CDC used TCP socket fallback to pause binlog stream for ${this.databaseId}`);
        return true;
      }
    } catch (error) {
      logger.warn(`Failed to pause binlog stream for ${this.databaseId}:`, error);
    }
    return false;
  }

  /**
   * Resume the underlying binlog connection after queue drains.
   * Tries connection.resume() first, then falls back to connection.stream.resume().
   */
  private resumeBinlogStream(): void {
    const conn = (this.zongji as any)?.connection;
    try {
      if (typeof conn?.resume === 'function') {
        conn.resume();
        return;
      }
      // Fallback: resume the raw TCP socket directly
      if (typeof conn?.stream?.resume === 'function') {
        conn.stream.resume();
        logger.debug(`CDC used TCP socket fallback to resume binlog stream for ${this.databaseId}`);
        return;
      }
    } catch (error) {
      logger.warn(`Failed to resume binlog stream for ${this.databaseId}:`, error);
    }
  }

  /**
   * Force disconnect and reconnect when the queue hits critical capacity
   * and native backpressure is unavailable. This trades a brief disconnect
   * for system stability, preventing OOM crashes.
   */
  private forceReconnectForBackpressure(): void {
    const criticalSize = this.maxQueueSize * this.criticalQueueMultiplier;
    logger.error(
      `CDC critical queue overflow for ${this.databaseId}: queue size ${this.eventQueue.length} exceeded critical limit ${criticalSize}. ` +
      `Forcing disconnect to prevent OOM. Will reconnect from last saved binlog position.`
    );

    // Stop zongji to sever the connection and prevent further events
    if (this.zongji) {
      try {
        this.zongji.stop();
      } catch (error) {
        logger.warn(`Error stopping zongji during forced backpressure disconnect for ${this.databaseId}:`, error);
      }
      this.zongji = null;
    }

    this.isPaused = false;
    this.isRunning = false;
    this.stats.isRunning = false;

    // Schedule reconnect from last saved position (same as error recovery path)
    this.scheduleReconnect();
  }

  /**
   * Process event queue serially to ensure correct ordering
   */
  private async processEventQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.eventQueue.length > 0) {
      const task = this.eventQueue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          this.stats.errors++;
          logger.error(`CDC event processing error, halting queue:`, error);
          this.eventQueue.length = 0;
          this.isProcessingQueue = false;
          if (this.queueDrainResolve) {
            this.queueDrainResolve();
            this.queueDrainResolve = null;
            this.queueDrainPromise = null;
          }
          this.scheduleReconnect();
          return;
        }
      }

      // Update queue size stat
      this.stats.queueSize = this.eventQueue.length;

      // Resume binlog stream when queue drains below half capacity
      if (this.isPaused && this.eventQueue.length < this.maxQueueSize / 2) {
        this.isPaused = false;
        this.resumeBinlogStream();
        logger.info(`CDC queue below threshold (${this.eventQueue.length}/${this.maxQueueSize}), resuming binlog stream for ${this.databaseId}`);
      }
    }

    this.isProcessingQueue = false;

    // Resolve drain promise if someone is waiting
    if (this.queueDrainResolve) {
      this.queueDrainResolve();
      this.queueDrainResolve = null;
      this.queueDrainPromise = null;
    }
  }

  /**
   * Wait for the event queue to drain completely
   */
  private async waitForQueueDrain(): Promise<void> {
    // If queue is empty and not processing, resolve immediately
    if (this.eventQueue.length === 0 && !this.isProcessingQueue) {
      return;
    }

    // If already have a drain promise, reuse it
    if (this.queueDrainPromise) {
      return this.queueDrainPromise;
    }

    // Create a new drain promise
    this.queueDrainPromise = new Promise<void>((resolve) => {
      this.queueDrainResolve = resolve;
    });

    return this.queueDrainPromise;
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
    if (rows.length === 0) return;

    await this.cacheTableSchema(tableName);
    const schema = this.tableSchemas.get(tableName);

    if (!schema || schema.size === 0) {
      throw new Error(`No schema found for table ${tableName}, cannot apply INSERT`);
    }

    try {
      const columns = Object.keys(rows[0]);
      const hasMixedShape = rows.some(row => Object.keys(row).join('|') !== columns.join('|'));
      if (hasMixedShape) {
        for (const row of rows) {
          const rowColumns = Object.keys(row);
          const quotedColumns = rowColumns.map(col => this.q(col)).join(', ');
          const values = rowColumns.map(col => this.sanitizeValue(row[col]));
          const placeholders = rowColumns.map(() => '?').join(', ');
          const query = `INSERT OR REPLACE INTO ${this.q(tableName)} (${quotedColumns}) VALUES (${placeholders})`;
          await this.duckdb.run(query, values, 'high');
        }
        this.stats.insertsProcessed += rows.length;
        logger.debug(`CDC INSERT: ${tableName} - ${rows.length} rows`);
        return;
      }

      const sanitizedRows = await this.sanitizeRows(rows, columns, schema);
      const quotedColumns = columns.map(col => this.q(col)).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const query = `INSERT OR REPLACE INTO ${this.q(tableName)} (${quotedColumns}) VALUES (${placeholders})`;

      for (const values of sanitizedRows) {
        await this.duckdb.run(query, values, 'high');
      }

      this.stats.insertsProcessed += rows.length;
      logger.debug(`CDC INSERT: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC INSERT failed for ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Handle UPDATE event
   */
  private async handleUpdate(tableName: string, rows: any[]): Promise<void> {
    if (!this.shouldProcessTable(tableName)) return;
    if (rows.length === 0) return;

    await this.cacheTableSchema(tableName);
    const schema = this.tableSchemas.get(tableName);

    if (!schema || schema.size === 0) {
      throw new Error(`No schema found for table ${tableName}, cannot apply UPDATE`);
    }

    try {
      const afterRows = rows.map(row => row.after || row);
      const columns = Object.keys(afterRows[0]);
      const hasMixedShape = afterRows.some(row => Object.keys(row).join('|') !== columns.join('|'));
      if (hasMixedShape) {
        for (const row of afterRows) {
          const rowColumns = Object.keys(row);
          const quotedColumns = rowColumns.map(col => this.q(col)).join(', ');
          const values = rowColumns.map(col => this.sanitizeValue(row[col]));
          const placeholders = rowColumns.map(() => '?').join(', ');
          const query = `INSERT OR REPLACE INTO ${this.q(tableName)} (${quotedColumns}) VALUES (${placeholders})`;
          await this.duckdb.run(query, values, 'high');
        }
        this.stats.updatesProcessed += rows.length;
        logger.debug(`CDC UPDATE: ${tableName} - ${rows.length} rows`);
        return;
      }

      const sanitizedRows = await this.sanitizeRows(afterRows, columns, schema);
      const quotedColumns = columns.map(col => this.q(col)).join(', ');
      const placeholders = columns.map(() => '?').join(', ');

      // Use INSERT OR REPLACE for upsert behavior
      const query = `INSERT OR REPLACE INTO ${this.q(tableName)} (${quotedColumns}) VALUES (${placeholders})`;
      for (const values of sanitizedRows) {
        await this.duckdb.run(query, values, 'high');
      }

      this.stats.updatesProcessed += rows.length;
      logger.debug(`CDC UPDATE: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC UPDATE failed for ${tableName}:`, error);
      throw error;
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
          const query = `DELETE FROM ${this.q(tableName)} WHERE ${this.q(pkColumn)} = ?`;
          await this.duckdb.run(query, [row[pkColumn]], 'high');
        } else {
          // Fallback: delete by all columns (exact match)
          const columns = Object.keys(row);
          const conditions = columns.map(col => `${this.q(col)} = ?`).join(' AND ');
          const values = columns.map(col => this.sanitizeValue(row[col]));

          const query = `DELETE FROM ${this.q(tableName)} WHERE ${conditions}`;
          await this.duckdb.run(query, values, 'high');
        }
      }

      this.stats.deletesProcessed += rows.length;
      logger.debug(`CDC DELETE: ${tableName} - ${rows.length} rows`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`CDC DELETE failed for ${tableName}:`, error);
      throw error;
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
      // Zero date (0000-00-00) comes as invalid Date or epoch 0
      if (isNaN(value.getTime()) || value.getFullYear() === 0) {
        return null;
      }
      return value.toISOString();
    }

    // Handle zero date strings
    if (value === '0000-00-00' || value === '0000-00-00 00:00:00') {
      return null;
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

  private async sanitizeRows(rows: any[], columns: string[], schema: Map<string, string>): Promise<any[][]> {
    if (rows.length === 0 || columns.length === 0) {
      return [];
    }

    const columnTypes: Record<string, string> = {};
    for (const col of columns) {
      columnTypes[col] = schema.get(col) || '';
    }

    if (!this.workerPool.isDisabled) {
      try {
        return await this.workerPool.sanitizeBatch(rows, columns, columnTypes);
      } catch (error) {
        logger.warn(`CDC worker sanitization failed for ${this.databaseId}, falling back to main-thread sanitization`, error);
      }
    }

    return rows.map(row => columns.map(col => this.sanitizeValue(row[col])));
  }

  /**
   * Resolve current binlog filename for checkpoint persistence.
   * Row events do not carry binlogName, so this falls back to tracked state.
   */
  private resolveBinlogFilename(event: any): string | null {
    if (event?.binlogName && typeof event.binlogName === 'string') {
      return event.binlogName;
    }

    const zongjiFilename = (this.zongji as any)?.options?.filename;
    if (zongjiFilename && typeof zongjiFilename === 'string') {
      return zongjiFilename;
    }

    if (this.currentBinlogFilename) {
      return this.currentBinlogFilename;
    }

    if (this.stats.currentPosition?.filename) {
      return this.stats.currentPosition.filename;
    }

    return null;
  }

  /**
   * Start CDC streaming
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`CDC already running for ${this.databaseId}`);
      return;
    }

    this.isStopped = false; // Reset stopped flag
    this.isPaused = false;
    this.backpressureAvailable = false; // Will be set in 'ready' event after connection check
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
        // rejectUnauthorized defaults to true for security, set CDC_SSL_REJECT_UNAUTHORIZED=false for self-signed certs
        ssl: {
          rejectUnauthorized: appConfig.cdc.sslRejectUnauthorized
        }
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Start options
      const startOptions: any = {
        includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows', 'rotate'],
        includeSchema: {
          [this.config.mysqlDatabase]: true
        }
      };

      // Resume from last position if available
      if (lastPosition) {
        startOptions.filename = lastPosition.filename;
        startOptions.position = lastPosition.position;
        this.currentBinlogFilename = lastPosition.filename;
        this.stats.currentPosition = lastPosition;
        logger.info(`Resuming CDC from position: ${lastPosition.filename}:${lastPosition.position}`);
      } else {
        startOptions.startAtEnd = true;
        this.currentBinlogFilename = null;
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

      // Verify backpressure capability (pause/resume are used by ZongJi itself at index.js:258/263)
      const conn = (this.zongji as any)?.connection;
      if (typeof conn?.pause === 'function' && typeof conn?.resume === 'function') {
        this.backpressureAvailable = true;
      } else if (typeof conn?.stream?.pause === 'function' && typeof conn?.stream?.resume === 'function') {
        this.backpressureAvailable = true;
        logger.info(`CDC backpressure for ${this.databaseId} will use TCP socket fallback (connection.stream.pause/resume).`);
      } else {
        this.backpressureAvailable = false;
        const criticalSize = this.maxQueueSize * this.criticalQueueMultiplier;
        logger.warn(
          `CDC backpressure unavailable for ${this.databaseId}: connection.pause/resume not found. ` +
          `Will force disconnect at critical queue size (${criticalSize}) to prevent OOM.`
        );
      }
    });

    // Binlog event - queue events for serial processing to ensure correct ordering
    this.zongji.on('binlog', (event: any) => {
      // Backpressure: pause binlog stream if queue is full
      if (!this.isPaused && this.eventQueue.length >= this.maxQueueSize) {
        this.isPaused = true;
        const paused = this.pauseBinlogStream();
        if (paused) {
          logger.warn(`CDC queue full (${this.eventQueue.length}/${this.maxQueueSize}), pausing binlog stream for ${this.databaseId}`);
        } else {
          logger.warn(`CDC queue full (${this.eventQueue.length}/${this.maxQueueSize}), pause failed for ${this.databaseId}. Queue may continue to grow.`);
        }
      }

      // Critical limit: force reconnect if backpressure is unavailable and queue is dangerously large
      const criticalSize = this.maxQueueSize * this.criticalQueueMultiplier;
      if (this.eventQueue.length >= criticalSize && !this.backpressureAvailable) {
        this.forceReconnectForBackpressure();
        return; // Drop this event; it will be re-read from saved binlog position after reconnect
      }

      // Track high water mark for observability
      if (this.eventQueue.length > this.stats.queueHighWaterMark) {
        this.stats.queueHighWaterMark = this.eventQueue.length;
      }

      // Push event processing to queue
      this.eventQueue.push(async () => {
        this.stats.eventsProcessed++;
        this.stats.lastEventAt = new Date();

        const eventName = event.getTypeName();
        if (eventName === 'Rotate' && event.binlogName) {
          this.currentBinlogFilename = event.binlogName;
        }
        const shouldSavePosition = Boolean(
          event.nextPosition && (this.stats.eventsProcessed % 100 === 0 ||
          ['WriteRows', 'UpdateRows', 'DeleteRows'].includes(eventName))
        );

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

        // Save position only after event processing completes successfully
        if (shouldSavePosition) {
          const filename = this.resolveBinlogFilename(event);
          if (!filename) {
            throw new Error(`Unable to resolve binlog filename for checkpoint at position ${event.nextPosition}`);
          }
          await this.savePosition(filename, event.nextPosition);
        }
      });

      // Process queue (will be no-op if already processing)
      this.processEventQueue();
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
    if (this.isStopped) {
      logger.debug(`CDC reconnect skipped - service was explicitly stopped for ${this.databaseId}`);
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`CDC max reconnect attempts reached for ${this.databaseId}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    logger.info(`CDC reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimeoutId = setTimeout(async () => {
      // Check if stopped before attempting reconnect
      if (this.isStopped) {
        logger.debug(`CDC reconnect cancelled - service was stopped for ${this.databaseId}`);
        return;
      }

      try {
        await this.stop();
        await this.start();
      } catch (error) {
        logger.error(`CDC reconnect failed for ${this.databaseId}:`, error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Stop CDC streaming gracefully, waiting for queue to drain
   */
  async stop(): Promise<void> {
    this.isStopped = true; // Mark as explicitly stopped

    // Clear any pending reconnect timeout
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    // Stop zongji first to prevent new events
    if (this.zongji) {
      try {
        this.zongji.stop();
      } catch (error) {
        logger.warn(`Error stopping zongji for ${this.databaseId}:`, error);
      }
      this.zongji = null;
    }

    // Wait for pending events in queue to finish processing
    if (this.eventQueue.length > 0 || this.isProcessingQueue) {
      logger.info(`CDC waiting for ${this.eventQueue.length} pending events to drain for ${this.databaseId}...`);
      await this.waitForQueueDrain();
      logger.info(`CDC queue drained for ${this.databaseId}`);
    }

    this.isPaused = false;
    this.isRunning = false;
    this.stats.isRunning = false;
    logger.info(`CDC service stopped for ${this.databaseId}`);
  }

  /**
   * Get CDC statistics
   */
  getStats(): CDCStats {
    return { ...this.stats, queueSize: this.eventQueue.length };
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
      errors: 0,
      queueHighWaterMark: 0
    };
  }

  /**
   * Stop all CDC instances gracefully, waiting for all queues to drain
   */
  static async stopAll(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const [databaseId, instance] of CDCService.instances) {
      logger.info(`Stopping CDC for ${databaseId}`);
      stopPromises.push(instance.stop());
    }

    // Wait for all instances to stop
    await Promise.all(stopPromises);
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
