import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Export all types from types.ts
export * from './types';

// Import runtime error types
import {
  DuckDBError,
  DuckDBErrorType
} from './types';

// Import types for internal use
import type {
  QueryMessage,
  QueryResponse,
  DuckDBSDKConfig,
  RequiredDuckDBSDKConfig,
  PendingRequest,
  ConnectionStats,
  DucklingClientEvents,
  BatchQueryRequest,
  BatchQueryResult,
  PaginationOptions,
  PaginatedResult,
  QueryRow
} from './types';

// Import logger
import { Logger, LogLevel } from './logger';

const NON_RECONNECT_CLOSE_CODES = new Set([1008, 1011]);

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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private manualClose: boolean = false;
  private reconnectExhaustedEmitted: boolean = false;
  private tornDownSockets: WeakSet<WebSocket> = new WeakSet();
  private logger: Logger;

  constructor(config: DuckDBSDKConfig) {
    super();
    this.config = {
      autoConnect: true,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
      requestTimeout: 30000,
      autoPing: true,
      pingInterval: 30000,
      enableLogging: false,
      logLevel: 'info',
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
   * Connect to DuckDB WebSocket server and authenticate.
   * Resets the reconnect budget so auto-reconnect gets a fresh cycle.
   */
  async connect(): Promise<void> {
    this.reconnectAttempts = 0;
    this.reconnectExhaustedEmitted = false;
    return this._doConnect();
  }

  /**
   * Internal connect — called by both the public API and the reconnect timer.
   * Does NOT reset the reconnect budget so scheduled retries accumulate.
   */
  private async _doConnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.isAuthenticated) {
      return; // Already connected and authenticated
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manualClose = false;
    this.isConnecting = true;
    this.clearReconnectTimer();

    // Tear down any stale socket before replacing it with a new attempt.
    if (this.ws) {
      const staleSocket = this.ws;
      this.teardownSocket(
        staleSocket,
        this.createError(DuckDBErrorType.CONNECTION_ERROR, 'Replacing stale connection before reconnect'),
        false
      );
      this.forceTerminateSocket(staleSocket);
    }

    // Build WebSocket URL with database parameter
    const url = new URL(this.config.url);
    url.searchParams.set('db', this.config.databaseName);

    const socket = new WebSocket(url.toString());
    this.ws = socket;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const timeout = setTimeout(() => {
        const error = this.createError(
          DuckDBErrorType.TIMEOUT_ERROR,
          `Connection timeout after ${this.config.connectionTimeout}ms`
        );
        this.reportError(error);
        this.teardownSocket(socket, error, true);
        this.forceTerminateSocket(socket);
      }, this.config.connectionTimeout);

      socket.on('open', async () => {
        if (this.ws !== socket || this.tornDownSockets.has(socket)) {
          return;
        }

        try {
          // Authenticate with API key
          await this.authenticate();

          if (this.ws !== socket || this.tornDownSockets.has(socket)) {
            return;
          }

          clearTimeout(timeout);
          this.isConnecting = false;
          this.isAuthenticated = true;
          this.reconnectAttempts = 0;
          this.resolveConnectPromise();
          this.emit('connected');

          // Start automatic ping if enabled
          if (this.config.autoPing) {
            this.startAutoPing();
          }
        } catch (error) {
          clearTimeout(timeout);
          if (this.tornDownSockets.has(socket)) {
            return;
          }

          const authError = this.toDuckDBError(
            error,
            DuckDBErrorType.AUTH_ERROR,
            'Authentication failed'
          );
          this.reportError(authError);
          this.teardownSocket(socket, authError, authError.type !== DuckDBErrorType.AUTH_ERROR);
          this.forceTerminateSocket(socket);
        }
      });

      socket.on('message', (data: WebSocket.RawData) => {
        if (this.ws !== socket || this.tornDownSockets.has(socket)) {
          return;
        }
        this.handleMessage(data);
      });

      socket.on('error', (error) => {
        if (this.ws !== socket || this.tornDownSockets.has(socket)) {
          return;
        }

        clearTimeout(timeout);
        const connectionError = this.toDuckDBError(
          error,
          DuckDBErrorType.CONNECTION_ERROR,
          'WebSocket connection error'
        );
        this.reportError(connectionError);
        this.teardownSocket(socket, connectionError, !this.manualClose);
        this.forceTerminateSocket(socket);
      });

      socket.on('close', (code, reasonBuffer) => {
        if (this.ws !== socket || this.tornDownSockets.has(socket)) {
          return;
        }

        clearTimeout(timeout);
        const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '');
        const closeError = this.createError(
          DuckDBErrorType.CONNECTION_ERROR,
          this.manualClose ? 'Connection closed' : `Connection closed${code ? ` (code ${code})` : ''}`,
          {
            code,
            reason: reason || undefined
          }
        );
        this.teardownSocket(
          socket,
          closeError,
          !this.manualClose && this.shouldReconnectForCloseCode(code)
        );
      });
    });

    return this.connectPromise;
  }

  private resolveConnectPromise(): void {
    const resolve = this.connectResolve;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.();
  }

  private rejectConnectPromise(error: Error): void {
    const reject = this.connectReject;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(error);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.manualClose ||
      !this.config.autoReconnect ||
      this.reconnectTimer
    ) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      if (!this.reconnectExhaustedEmitted) {
        this.reconnectExhaustedEmitted = true;
        this.emit(
          'reconnectExhausted',
          this.reconnectAttempts,
          this.createError(
            DuckDBErrorType.CONNECTION_ERROR,
            `Reconnect attempts exhausted after ${this.reconnectAttempts} tries`
          )
        );
      }
      return;
    }

    const attempt = ++this.reconnectAttempts;
    const delay = this.config.reconnectDelay * (2 ** (attempt - 1));
    this.emit('reconnecting', attempt);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._doConnect().catch((error) => {
        this.reportError(this.toDuckDBError(error, DuckDBErrorType.CONNECTION_ERROR, 'Reconnect failed'));
      });
    }, delay);
  }

  private rejectPendingRequests(error: Error): void {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pendingRequests.clear();
  }

  private teardownSocket(socket: WebSocket, error: Error, shouldReconnect: boolean): void {
    if (this.tornDownSockets.has(socket)) {
      return;
    }

    this.tornDownSockets.add(socket);

    if (this.ws === socket) {
      this.ws = null;
    }

    const hadConnection = this.isConnecting || this.isAuthenticated || socket.readyState === WebSocket.OPEN;

    this.isConnecting = false;
    this.isAuthenticated = false;
    this.stopAutoPing();
    this.rejectPendingRequests(error);
    this.rejectConnectPromise(error);

    socket.removeAllListeners();

    if (hadConnection) {
      this.emit('disconnected');
    }

    if (shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private forceTerminateSocket(socket: WebSocket): void {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    } catch {
      // Ignore secondary teardown failures
    }
  }

  private shouldReconnectForCloseCode(code: number): boolean {
    return !NON_RECONNECT_CLOSE_CODES.has(code);
  }

  private reportError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      super.emit('error', error);
      return;
    }

    if (error instanceof DuckDBError) {
      this.logger.error(error.message, {
        type: error.type,
        context: error.context
      });
      return;
    }

    this.logger.error(error.message, { name: error.name });
  }

  private createError(
    type: DuckDBErrorType,
    message: string,
    context?: Record<string, unknown>
  ): DuckDBError {
    return new DuckDBError(type, message, context);
  }

  private toDuckDBError(
    error: unknown,
    fallbackType: DuckDBErrorType,
    fallbackMessage: string,
    context?: Record<string, unknown>
  ): DuckDBError {
    if (error instanceof DuckDBError) {
      return error;
    }

    if (error instanceof Error) {
      return this.createError(fallbackType, error.message || fallbackMessage, context);
    }

    return this.createError(fallbackType, fallbackMessage, {
      ...context,
      cause: error
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
      throw this.createError(
        DuckDBErrorType.AUTH_ERROR,
        `Authentication failed: ${response.error || 'Unknown error'}`
      );
    }
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
      throw this.createError(
        DuckDBErrorType.CONNECTION_ERROR,
        'Not connected. Call connect() first or enable autoConnect.'
      );
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
      throw this.createError(
        DuckDBErrorType.QUERY_ERROR,
        `Query failed: ${response.error || 'Unknown error'}`,
        {
          sql,
          params,
          duration: response.duration
        }
      );
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
          const error = this.createError(
            DuckDBErrorType.CONNECTION_ERROR,
            'Ping failed - connection may be unhealthy'
          );
          this.reportError(error);
          if (this.ws) {
            const unhealthySocket = this.ws;
            this.teardownSocket(unhealthySocket, error, true);
            this.forceTerminateSocket(unhealthySocket);
          }
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
    this.manualClose = true;
    this.stopAutoPing();
    this.clearReconnectTimer();

    if (this.ws) {
      const socket = this.ws;
      this.teardownSocket(
        socket,
        this.createError(DuckDBErrorType.CONNECTION_ERROR, 'Connection closed by client'),
        false
      );
      try {
        socket.close();
      } catch {
        // Ignore close failures during shutdown
      }
    }
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
        reject(this.createError(DuckDBErrorType.CONNECTION_ERROR, 'WebSocket not connected'));
        return;
      }

      // Set timeout for each request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.id);
        reject(
          this.createError(DuckDBErrorType.TIMEOUT_ERROR, `Request timeout: ${message.id}`, {
            messageId: message.id,
            type: message.type
          })
        );
      }, this.config.requestTimeout);

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
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const raw =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString()
            : Array.isArray(data)
              ? Buffer.concat(data).toString()
              : Buffer.from(data).toString();
      const response: QueryResponse = JSON.parse(raw);
      const request = this.pendingRequests.get(response.id);

      this.emit('message', response);

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
      this.reportError(
        this.toDuckDBError(error, DuckDBErrorType.UNKNOWN_ERROR, 'Failed to parse incoming message')
      );
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
