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
  },
  
  mysql: {
    connectionString: process.env.MYSQL_CONNECTION_STRING || '',
    maxConnections: parseInt(process.env.MYSQL_MAX_CONNECTIONS || '5'),
  },
  
  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '15'),
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    insertBatchSize: parseInt(process.env.INSERT_BATCH_SIZE || '2000'),
    appenderFlushInterval: parseInt(process.env.APPENDER_FLUSH_INTERVAL || '5000'),
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

  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    categories: {
      auth: {
        windowMs: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10'),
      },
      read: {
        windowMs: parseInt(process.env.RATE_LIMIT_READ_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_READ_MAX || '60'),
      },
      query: {
        windowMs: parseInt(process.env.RATE_LIMIT_QUERY_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_QUERY_MAX || '20'),
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
    cleanupIntervalMs: parseInt(process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS || '60000'),
  }
};

export function getAuthSecurityIssues(auth = config.auth): string[] {
  const issues: string[] = [];
  if (auth.jwtSecret === DEFAULT_JWT_SECRET) {
    issues.push('JWT_SECRET is using the insecure default value.');
  }
  if (!auth.adminUsername.trim() || !auth.adminPassword.trim()) {
    issues.push('ADMIN_USERNAME and ADMIN_PASSWORD must both be set to non-empty values.');
  }
  return issues;
}

export default config;
