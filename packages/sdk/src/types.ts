/**
 * ClickHouse SDK Type Definitions
 *
 * Comprehensive type system for the ClickHouse WebSocket SDK
 */

// ============================================================================
// Core Message Types
// ============================================================================

/**
 * Message types supported by the ClickHouse WebSocket server
 */
export type MessageType = 'query' | 'ping' | 'auth';

/**
 * Query message sent to ClickHouse server
 */
export interface QueryMessage {
  /** Unique identifier for this message */
  id: string;
  /** Type of message being sent */
  type: MessageType;
  /** SQL query to execute (required for 'query' type) */
  sql?: string;
  /** Optional query parameters for parameterized queries */
  params?: any[];
  /** API key for authentication (required for 'auth' type) */
  apiKey?: string;
}

/**
 * Response from ClickHouse server
 */
export interface QueryResponse<T = any> {
  /** Message ID that this response corresponds to */
  id: string;
  /** Whether the operation was successful */
  success: boolean;
  /** Query result rows (present on success) */
  result?: T[];
  /** Error message (present on failure) */
  error?: string;
  /** Query execution duration in milliseconds */
  duration?: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * SDK configuration options
 */
export interface ClickHouseSDKConfig {
  /** WebSocket server URL (e.g., ws://localhost:3001/ws) */
  url: string;
  /** API key for authentication */
  apiKey: string;
  /** Database name to connect to (default: 'default') */
  databaseName?: string;
  /** Auto-connect on first query (default: true) */
  autoConnect?: boolean;
  /** Auto-reconnect on connection failure (default: true) */
  autoReconnect?: boolean;
  /** Max reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Reconnect delay in milliseconds (default: 1000) */
  reconnectDelay?: number;
  /** Connection timeout in milliseconds (default: 5000) */
  connectionTimeout?: number;
  /** Per-request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Enable automatic ping to keep connection alive (default: true) */
  autoPing?: boolean;
  /** Ping interval in milliseconds (default: 30000) */
  pingInterval?: number;
  /** Enable logging of queries and results (default: false) */
  enableLogging?: boolean;
  /** Log level for debugging (default: INFO) */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Complete SDK configuration with all defaults applied
 */
export type RequiredClickHouseSDKConfig = Required<ClickHouseSDKConfig>;

// ============================================================================
// Connection State Types
// ============================================================================

/**
 * WebSocket connection states
 */
export enum ConnectionState {
  /** Not yet connected */
  DISCONNECTED = 'disconnected',
  /** Attempting to connect */
  CONNECTING = 'connecting',
  /** Connected but not authenticated */
  CONNECTED = 'connected',
  /** Connected and authenticated */
  AUTHENTICATED = 'authenticated',
  /** Connection lost, attempting to reconnect */
  RECONNECTING = 'reconnecting',
  /** Connection closed intentionally */
  CLOSED = 'closed'
}

/**
 * Connection statistics
 */
export interface ConnectionStats {
  /** Whether the client is currently connected and authenticated */
  connected: boolean;
  /** Whether the client has been authenticated */
  authenticated: boolean;
  /** Number of pending requests waiting for responses */
  pendingRequests: number;
  /** Number of reconnection attempts made */
  reconnectAttempts: number;
  /** WebSocket server URL */
  url: string;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Events emitted by the Duckling client
 */
export interface DucklingClientEvents {
  /** Emitted when successfully connected to the server */
  connected: () => void;
  /** Emitted when disconnected from the server */
  disconnected: () => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted when reconnection attempt starts */
  reconnecting: (attempt: number) => void;
  /** Emitted when auto-reconnect gives up after the configured attempts */
  reconnectExhausted: (attempts: number, error: Error) => void;
  /** Emitted when a message is received */
  message: (response: QueryResponse) => void;
}

/**
 * Event names that the client can emit
 */
export type DucklingClientEventName = keyof DucklingClientEvents;


// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Generic query result row type
 */
export type QueryRow = Record<string, any>;

/**
 * Typed query result for COUNT queries
 */
export interface CountResult {
  count: number;
}

/**
 * Typed query result for aggregate queries
 */
export interface AggregateResult {
  count?: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
}

/**
 * Schema information for a table column
 */
export interface ColumnSchema {
  /** Column name */
  name: string;
  /** Column data type (e.g., VARCHAR, INTEGER, TIMESTAMP) */
  type: string;
  /** Whether the column can be NULL */
  nullable: boolean;
  /** Whether the column is a primary key */
  isPrimaryKey?: boolean;
  /** Default value for the column */
  defaultValue?: any;
}

/**
 * Table schema information
 */
export interface TableSchema {
  /** Table name */
  tableName: string;
  /** Columns in the table */
  columns: ColumnSchema[];
  /** Total number of rows (if available) */
  rowCount?: number;
}

// ============================================================================
// Pagination Types
// ============================================================================

/**
 * Pagination options for queries
 */
export interface PaginationOptions {
  /** Number of rows to return */
  limit: number;
  /** Number of rows to skip */
  offset: number;
}

/**
 * Paginated query result
 */
export interface PaginatedResult<T = QueryRow> {
  /** Result rows for the current page */
  data: T[];
  /** Current page information */
  pagination: {
    /** Current offset */
    offset: number;
    /** Number of rows returned */
    limit: number;
    /** Total number of rows (if available) */
    total?: number;
    /** Whether there are more rows */
    hasMore?: boolean;
  };
}

// ============================================================================
// Batch Query Types
// ============================================================================

/**
 * Batch query request
 */
export interface BatchQueryRequest {
  /** SQL query */
  sql: string;
  /** Optional parameters */
  params?: any[];
}

/**
 * Batch query result
 */
export interface BatchQueryResult<T = QueryRow> {
  /** The original query */
  query: string;
  /** Whether the query succeeded */
  success: boolean;
  /** Query results (present on success) */
  data?: T[];
  /** Error message (present on failure) */
  error?: string;
  /** Query execution duration in milliseconds */
  duration?: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * ClickHouse SDK error types
 */
export enum ClickHouseErrorType {
  /** Connection-related errors */
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  /** Authentication errors */
  AUTH_ERROR = 'AUTH_ERROR',
  /** Query execution errors */
  QUERY_ERROR = 'QUERY_ERROR',
  /** Timeout errors */
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  /** Configuration errors */
  CONFIG_ERROR = 'CONFIG_ERROR',
  /** Unknown errors */
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Enhanced error with type and context
 */
export class ClickHouseError extends Error {
  constructor(
    public type: ClickHouseErrorType,
    message: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'ClickHouseError';
    Object.setPrototypeOf(this, ClickHouseError.prototype);
  }
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract row type from a SQL query (for type inference)
 */
export type InferRowType<T> = T extends Promise<infer U>
  ? U extends Array<infer R>
    ? R
    : never
  : never;

/**
 * Make specific properties required
 */
export type RequireProperties<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Make specific properties optional
 */
export type OptionalProperties<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Deep partial type
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Promise or sync value
 */
export type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Internal Types (used by SDK implementation)
// ============================================================================

/**
 * Pending request tracking
 * @internal
 */
export interface PendingRequest {
  /** Resolve callback for the promise */
  resolve: (value: QueryResponse) => void;
  /** Reject callback for the promise */
  reject: (error: Error) => void;
  /** Timeout handle for request timeout */
  timeout: NodeJS.Timeout;
}

/**
 * Reconnection state
 * @internal
 */
export interface ReconnectionState {
  /** Number of attempts made */
  attempts: number;
  /** Whether reconnection is in progress */
  inProgress: boolean;
  /** Last reconnection attempt timestamp */
  lastAttempt?: number;
}
