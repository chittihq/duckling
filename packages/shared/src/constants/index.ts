/**
 * API routes constants
 */
export const API_ROUTES = {
  // Health & Status
  HEALTH: '/health',
  STATUS: '/status',
  METRICS: '/metrics',

  // Sync operations
  SYNC_FULL: '/sync/full',
  SYNC_INCREMENTAL: '/sync/incremental',
  SYNC_TABLE: '/sync/table',
  SYNC_STATUS: '/sync/status',
  SYNC_VALIDATE: '/sync/validate',

  // Data access
  TABLES: '/tables',
  TABLE_SCHEMA: '/tables/:name/schema',
  TABLE_DATA: '/tables/:name/data',
  TABLE_COUNT: '/tables/:name/count',
  TABLE_COUNTS_ALL: '/tables/counts/all',
  QUERY: '/query',

  // WebSocket
  WEBSOCKET: '/ws',

  // Authentication
  LOGIN: '/api/login',
  CHECK_AUTH: '/api/check-auth',
  LOGOUT: '/api/logout',

  // Logs
  LOGS: '/api/logs',
  SYNC_LOGS: '/api/sync-logs',
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  PORT: 3000,
  SYNC_INTERVAL_MINUTES: 15,
  BATCH_SIZE: 10000,
  MAX_RETRIES: 3,
  MYSQL_MAX_CONNECTIONS: 5,
  HEALTH_CHECK_INTERVAL: 60000,
  LOG_LEVEL: 'info',
} as const;

/**
 * Architecture identifier
 */
export const ARCHITECTURE = 'clickhouse' as const;
