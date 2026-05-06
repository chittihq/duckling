import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const DEFAULT_JWT_SECRET = 'default-jwt-secret-change-in-production';

// Determine base data directory
// In Docker: /app/data (volume mounted from ./data)
// In development: ./data (relative to project root)
const getDataPath = (): string => {
  if (process.env.DATA_PATH) {
    return process.env.DATA_PATH;
  }
  // If running in Docker (__dirname is /app/packages/server/dist), use /app/data
  // If running in development (__dirname is /packages/server/src or dist), use ./data from project root
  if (__dirname.includes('/app/packages/')) {
    return '/app/data';
  }
  // Development: resolve to project root ./data
  return path.resolve(__dirname, '../../../data');
};

const DATA_PATH = getDataPath();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),

  paths: {
    data: DATA_PATH,
    backups: process.env.BACKUP_PATH || path.join(DATA_PATH, 'backups'),
    metadata: path.join(DATA_PATH, 'metadata'),
  },

  duckdb: {
    path: process.env.DUCKDB_PATH || path.join(DATA_PATH, 'duckling.db'),
    maxConnections: parseInt(process.env.DUCKDB_MAX_CONNECTIONS || '10'),
    memoryLimit: process.env.DUCKDB_MEMORY_LIMIT || '',
    threads: parseInt(process.env.DUCKDB_THREADS || '0'),
    tempDirectory: process.env.DUCKDB_TEMP_DIRECTORY || path.join(DATA_PATH, 'duckdb_tmp'),
    maxTempDirectorySize: process.env.DUCKDB_MAX_TEMP_DIRECTORY_SIZE || '',
    preserveInsertionOrder: process.env.DUCKDB_PRESERVE_INSERTION_ORDER !== undefined
      ? process.env.DUCKDB_PRESERVE_INSERTION_ORDER !== 'false'
      : false,
  },
  
  mysql: {
    connectionString: process.env.MYSQL_CONNECTION_STRING || '',
    maxConnections: parseInt(process.env.MYSQL_MAX_CONNECTIONS || '5'),
  },

  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'default',
  },
  
  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '15'),
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    insertBatchSize: parseInt(process.env.INSERT_BATCH_SIZE || '2000'),
    appenderFlushInterval: parseInt(process.env.APPENDER_FLUSH_INTERVAL || '5000'),
    fullSyncBatchSize: parseInt(process.env.FULL_SYNC_BATCH_SIZE || process.env.BATCH_SIZE || '1000'),
    fullSyncAppenderFlushInterval: parseInt(
      process.env.FULL_SYNC_APPENDER_FLUSH_INTERVAL ||
      process.env.APPENDER_FLUSH_INTERVAL ||
      '5000'
    ),
    fullSyncResumeEnabled: process.env.FULL_SYNC_RESUME_ENABLED !== 'false',
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '1000'),
    retryMaxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS || '60000'),
    enableIncremental: process.env.ENABLE_INCREMENTAL_SYNC !== 'false',
    excludedTables: process.env.EXCLUDED_TABLES !== undefined ?
      (process.env.EXCLUDED_TABLES === '' ? [] : process.env.EXCLUDED_TABLES.split(',').map(t => t.trim())) :
      [], // No tables excluded by default
  },

  automation: {
    autoStartSync: process.env.AUTO_START_SYNC !== 'false',
    autoCleanup: process.env.AUTO_CLEANUP !== 'false',
    cleanupIntervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24'),
    retentionDays: parseInt(process.env.RETENTION_DAYS || '90'),
    autoBackup: process.env.AUTO_BACKUP !== 'false',
    backupIntervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '24'),
    backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '7'),
    autoRestart: process.env.AUTO_RESTART !== 'false',
    maxRestartAttempts: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
  },

  cdc: {
    enabled: process.env.CDC_ENABLED === 'true', // Disabled by default, opt-in
    autoStart: process.env.CDC_AUTO_START === 'true', // Auto-start on server boot
    reconnectAttempts: parseInt(process.env.CDC_RECONNECT_ATTEMPTS || '10'),
    reconnectDelayMs: parseInt(process.env.CDC_RECONNECT_DELAY_MS || '5000'),
    sslRejectUnauthorized: process.env.CDC_SSL_REJECT_UNAUTHORIZED !== 'false', // true by default for security
    maxQueueSize: parseInt(process.env.CDC_MAX_QUEUE_SIZE || '5000'),
  },
  
  monitoring: {
    enableHealthChecks: process.env.ENABLE_HEALTH_CHECKS !== 'false',
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000'),
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  debug: {
    crashDiagnostics: process.env.CRASH_DEBUG !== 'false',
  },
  
  server: {
    enableCors: true,
    requestTimeout: 30000,
  },

  auth: {
    adminUsername: process.env.ADMIN_USERNAME || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    apiKey: process.env.DUCKLING_API_KEY || '',
    jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || DEFAULT_JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h', // 1 hour by default
  },

  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  },

  mysqlProtocol: {
    enabled: process.env.MYSQL_PROTOCOL_ENABLED !== 'false', // enabled by default
    port: parseInt(process.env.MYSQL_PROTOCOL_PORT || '3307'),
    defaultDatabase: process.env.MYSQL_PROTOCOL_DEFAULT_DB || 'default',
    maxConnections: parseInt(process.env.MYSQL_PROTOCOL_MAX_CONNECTIONS || '50'),
    username: process.env.MYSQL_PROTOCOL_USER || 'duckling',
    password: process.env.MYSQL_PROTOCOL_PASSWORD || process.env.DUCKLING_API_KEY || '',
  },

  governor: {
    maxConcurrentQueries: parseInt(process.env.MAX_CONCURRENT_QUERIES || '10'),
    queryTimeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS || '30000'),
    queryQueueMax: parseInt(process.env.QUERY_QUEUE_MAX || '50'),
  },

  workers: {
    threads: parseInt(process.env.WORKER_THREADS || '0'), // 0 = disabled (default), positive integer = that many threads
  },

  readReplica: {
    enabled: process.env.READ_REPLICA_ENABLED === 'true',
    refreshInterval: parseInt(process.env.REPLICA_REFRESH_INTERVAL || '300'),
  },

  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    mode: process.env.RATE_LIMIT_MODE === 'shadow' ? 'shadow' : 'enforce',
    categories: {
      auth: {
        windowMs: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10'),
      },
      read: {
        windowMs: parseInt(process.env.RATE_LIMIT_READ_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_READ_MAX || '120'),
      },
      query: {
        windowMs: parseInt(process.env.RATE_LIMIT_QUERY_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_QUERY_MAX || '80'),
      },
      write: {
        windowMs: parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_WRITE_MAX || '10'),
      },
      monitoring: {
        windowMs: parseInt(process.env.RATE_LIMIT_MONITORING_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_MONITORING_MAX || '120'),
      },
    },
    tiers: {
      anonymous: 1,
      jwt: parseInt(process.env.RATE_LIMIT_JWT_MULTIPLIER || '2'),
      apiKey: parseInt(process.env.RATE_LIMIT_APIKEY_MULTIPLIER || '5'),
    },
    costs: {
      auth: Math.max(1, parseInt(process.env.RATE_LIMIT_COST_AUTH || '1')),
      read: Math.max(1, parseInt(process.env.RATE_LIMIT_COST_READ || '1')),
      query: Math.max(1, parseInt(process.env.RATE_LIMIT_COST_QUERY || '1')),
      write: Math.max(1, parseInt(process.env.RATE_LIMIT_COST_WRITE || '3')),
      monitoring: Math.max(1, parseInt(process.env.RATE_LIMIT_COST_MONITORING || '1')),
    },
    identity: {
      useSessionScope: process.env.RATE_LIMIT_USE_SESSION_SCOPE === 'true',
      includeDatabaseScope: process.env.RATE_LIMIT_INCLUDE_DB_SCOPE === 'true',
    },
    queryConcurrency: {
      enabled: process.env.RATE_LIMIT_QUERY_CONCURRENCY_ENABLED !== 'false',
      anonymousMaxInFlight: Math.max(1, parseInt(process.env.RATE_LIMIT_ANON_QUERY_MAX_IN_FLIGHT || '1')),
      jwtMaxInFlight: Math.max(1, parseInt(process.env.RATE_LIMIT_JWT_QUERY_MAX_IN_FLIGHT || '6')),
      apiKeyMaxInFlight: Math.max(1, parseInt(process.env.RATE_LIMIT_APIKEY_QUERY_MAX_IN_FLIGHT || '12')),
      staleEntryTtlMs: Math.max(1000, parseInt(process.env.RATE_LIMIT_QUERY_INFLIGHT_TTL_MS || '300000')),
    },
    cleanupIntervalMs: parseInt(process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS || '60000'),
  }
};

export function getAuthSecurityIssues(auth = config.auth): string[] {
  const issues: string[] = [];
  if (auth.jwtSecret === DEFAULT_JWT_SECRET) {
    issues.push('JWT_SECRET is using the insecure default value.');
  }
  if (!auth.adminUsername.trim() || !auth.adminPassword.trim()) {
    issues.push('ADMIN_USERNAME and ADMIN_PASSWORD must each be set to a non-empty value.');
  }
  return issues;
}

export default config;
