import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Export all types from types.ts
export * from './types';

// Import types for internal use
import type {
  QueryMessage,
  QueryResponse,
  DuckDBSDKConfig,
  RequiredDuckDBSDKConfig,
  PendingRequest,
  ConnectionStats,
  DucklingClientEvents,
  DuckDBError,
  DuckDBErrorType,
  BatchQueryRequest,
  BatchQueryResult,
  PaginationOptions,
  PaginatedResult,
  QueryRow
} from './types';

// Import logger
import { Logger, LogLevel } from './logger';

/**
 * Duckling WebSocket SDK Client
 *
 * High-performance client for querying DuckDB server via WebSocket.
 * Supports connection pooling, auto-reconnect, and concurrent queries.
 *
 * @example
 * ```typescript
 * const client = new DucklingClient({
 *   url: 'ws://localhost:3001/ws',
 *   apiKey: 'your-api-key'
 * });
 *
 * await client.connect();
 * const result = await client.query('SELECT * FROM users LIMIT 10');
 * await client.close();
 * ```
 *
 * @example With typed results
 * ```typescript
 * interface User {
 *   id: number;
 *   name: string;
 *   email: string;
 * }
 *
 * const users = await client.query<User>('SELECT * FROM users LIMIT 10');
 * // users is typed as User[]
 * ```
 */
export class DucklingClient extends EventEmitter {
  private config: RequiredDuckDBSDKConfig;
  private ws: WebSocket | null = null;
  private isAuthenticated: boolean = false;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageIdCounter: number = 0;
  private pingIntervalHandle: NodeJS.Timeout | null = null;
  private logger: Logger;

  constructor(config: DuckDBSDKConfig) {
    super();
    this.config = {
      autoConnect: true,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
      autoPing: true,
      pingInterval: 30000,
      databaseName: 'default',
      ...config
    };

    // Initialize logger
    this.logger = new Logger({
      enabled: config.enableLogging ?? false,
      level: config.logLevel === 'error' ? LogLevel.ERROR :
               config.logLevel === 'warn' ? LogLevel.WARN :
               config.logLevel === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
      prefix: 'DucklingSDK'
    });
  }

  /**
   * Connect to DuckDB WebSocket server and authenticate
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.isAuthenticated) {
      return; // Already connected and authenticated
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), this.config.connectionTimeout);
        this.once('connected', () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
        this.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.isConnecting = false;
        reject(new Error(`Connection timeout after ${this.config.connectionTimeout}ms`));
      }, this.config.connectionTimeout);

      // Build WebSocket URL with database parameter
      const url = new URL(this.config.url);
      url.searchParams.set('db', this.config.databaseName);

      this.ws = new WebSocket(url.toString());

      this.ws.on('open', async () => {
        try {
          // Authenticate with API key
          await this.authenticate();
          clearTimeout(timeout);
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected');

          // Start automatic ping if enabled
          if (this.config.autoPing) {
            this.startAutoPing();
          }

          resolve();
        } catch (error) {
          clearTimeout(timeout);
          this.isConnecting = false;
          reject(error);
        }
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        this.emit('error', error);
        if (!this.isAuthenticated) {
          clearTimeout(timeout);
          this.isConnecting = false;
          reject(error);
        }
      });

      this.ws.on('close', () => {
        this.isAuthenticated = false;
        this.stopAutoPing();
        this.emit('disconnected');

        // Reject all pending requests
        for (const [id, request] of this.pendingRequests.entries()) {
          clearTimeout(request.timeout);
          request.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();

        // Auto-reconnect if enabled
        if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => {
            this.connect().catch(error => {
              this.emit('error', error);
            });
          }, this.config.reconnectDelay * this.reconnectAttempts);
        }
      });
    });
  }

  /**
   * Authenticate with API key
   */
  private async authenticate(): Promise<void> {
    const authMessage: QueryMessage = {
      id: this.generateMessageId(),
      type: 'auth',
      apiKey: this.config.apiKey
    };

    const response = await this.sendMessage(authMessage);

    if (!response.success) {
      throw new Error(`Authentication failed: ${response.error || 'Unknown error'}`);
    }

    this.isAuthenticated = true;
  }

  /**
   * Execute SQL query
   *
   * @param sql - SQL query to execute
   * @param params - Optional query parameters
   * @returns Query result rows
   */
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    // Auto-connect if enabled and not connected
    if (!this.isAuthenticated && this.config.autoConnect) {
      await this.connect();
    }

    if (!this.isAuthenticated) {
      throw new Error('Not connected. Call connect() first or enable autoConnect.');
    }

    // Log query reception
    this.logger.info('Executing query', {
      queryId: this.messageIdCounter,
      sql: sql,
      params: params,
      timestamp: new Date().toISOString()
    });

    const message: QueryMessage = {
      id: this.generateMessageId(),
      type: 'query',
      sql,
      params
    };

    const response = await this.sendMessage(message);

    if (!response.success) {
      this.logger.error('Query failed', {
        queryId: message.id,
        error: response.error,
        sql: sql,
        duration: response.duration
      });
      throw new Error(`Query failed: ${response.error || 'Unknown error'}`);
    }

    // Log query results
    this.logger.info('Query completed successfully', {
      queryId: message.id,
      rowCount: response.result?.length || 0,
      duration: response.duration,
      sql: sql
    });

    return response.result as T[];
  }

  /**
   * Execute multiple queries in parallel
   *
   * @param queries - Array of SQL queries
   * @returns Array of query results
   */
  async queryBatch<T = any>(queries: string[]): Promise<T[][]> {
    return Promise.all(queries.map(sql => this.query<T>(sql)));
  }

  /**
   * Ping server to check connection
   */
  async ping(): Promise<boolean> {
    if (!this.isAuthenticated) {
      return false;
    }

    try {
      const message: QueryMessage = {
        id: this.generateMessageId(),
        type: 'ping'
      };

      const response = await this.sendMessage(message);
      return response.success;
    } catch {
      return false;
    }
  }

  /**
   * Start automatic ping to keep connection alive
   */
  private startAutoPing(): void {
    if (this.pingIntervalHandle) {
      return; // Already running
    }

    this.pingIntervalHandle = setInterval(async () => {
      if (this.isAuthenticated) {
        const success = await this.ping();
        if (!success) {
          this.emit('error', new Error('Ping failed - connection may be unhealthy'));
        }
      }
    }, this.config.pingInterval);
  }

  /**
   * Stop automatic ping
   */
  private stopAutoPing(): void {
    if (this.pingIntervalHandle) {
      clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = null;
    }
  }

  /**
   * Close WebSocket connection
   */
  close(): void {
    this.config.autoReconnect = false; // Disable auto-reconnect
    this.stopAutoPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isAuthenticated = false;
  }

  /**
   * Check if client is connected and authenticated
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.isAuthenticated;
  }

  /**
   * Send message and wait for response
   */
  private sendMessage(message: QueryMessage): Promise<QueryResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Set timeout for request (30 seconds)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.id);
        reject(new Error(`Request timeout: ${message.id}`));
      }, 30000);

      this.pendingRequests.set(message.id, { resolve, reject, timeout });

      try {
        // Log outgoing message
        if (this.config.enableLogging) {
          this.logger.debug('Sending message to server', {
            messageId: message.id,
            messageType: message.type,
            sql: message.sql,
            params: message.params
          });
        }

        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(message.id);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: Buffer): void {
    try {
      const response: QueryResponse = JSON.parse(data.toString());
      const request = this.pendingRequests.get(response.id);

      if (request) {
        clearTimeout(request.timeout);
        this.pendingRequests.delete(response.id);

        // Log incoming response
        if (this.config.enableLogging) {
          if (response.success) {
            this.logger.debug('Received successful response', {
              messageId: response.id,
              rowCount: response.result?.length || 0,
              duration: response.duration
            });
          } else {
            this.logger.debug('Received error response', {
              messageId: response.id,
              error: response.error,
              duration: response.duration
            });
          }
        }

        request.resolve(response);
      }
    } catch (error) {
      this.logger.error('Failed to parse incoming message', { error });
      this.emit('error', new Error(`Failed to parse message: ${error}`));
    }
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `${Date.now()}-${this.messageIdCounter++}`;
  }

  /**
   * Get connection stats
   */
  getStats(): ConnectionStats {
    return {
      connected: this.isConnected(),
      authenticated: this.isAuthenticated,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempts: this.reconnectAttempts,
      url: this.config.url
    };
  }

  /**
   * Execute paginated query with LIMIT and OFFSET
   *
   * @param sql - Base SQL query (without LIMIT/OFFSET)
   * @param options - Pagination options
   * @returns Paginated result with metadata
   */
  async queryPaginated<T = QueryRow>(
    sql: string,
    options: PaginationOptions
  ): Promise<PaginatedResult<T>> {
    const { limit, offset } = options;

    // Add LIMIT and OFFSET to the query
    const paginatedSql = `${sql} LIMIT ${limit} OFFSET ${offset}`;

    const data = await this.query<T>(paginatedSql);

    return {
      data,
      pagination: {
        offset,
        limit,
        hasMore: data.length === limit
      }
    };
  }

  /**
   * Execute batch of queries with individual error handling
   *
   * @param requests - Array of query requests
   * @returns Array of batch results (success or error for each query)
   */
  async queryBatchDetailed<T = QueryRow>(
    requests: BatchQueryRequest[]
  ): Promise<BatchQueryResult<T>[]> {
    const results = await Promise.allSettled(
      requests.map(async (req) => {
        const startTime = Date.now();
        try {
          const data = await this.query<T>(req.sql, req.params);
          return {
            query: req.sql,
            success: true,
            data,
            duration: Date.now() - startTime
          };
        } catch (error) {
          return {
            query: req.sql,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime
          };
        }
      })
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          query: '',
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          duration: 0
        };
      }
    });
  }

  /**
   * Strongly typed event emitter methods
   */
  on<K extends keyof DucklingClientEvents>(
    event: K,
    listener: DucklingClientEvents[K]
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof DucklingClientEvents>(
    event: K,
    listener: DucklingClientEvents[K]
  ): this {
    return super.once(event, listener);
  }

  emit<K extends keyof DucklingClientEvents>(
    event: K,
    ...args: Parameters<DucklingClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
