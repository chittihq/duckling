import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),
  
  duckdb: {
    path: process.env.DUCKDB_PATH || path.join(__dirname, '..', 'data', 'duckling.db'),
    maxConnections: parseInt(process.env.DUCKDB_MAX_CONNECTIONS || '10'),
  },
  
  mysql: {
    connectionString: process.env.MYSQL_CONNECTION_STRING || '',
    maxConnections: parseInt(process.env.MYSQL_MAX_CONNECTIONS || '5'),
  },
  
  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '15'),
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
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
  }
};

export default config;