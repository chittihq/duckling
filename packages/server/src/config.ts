import dotenv from 'dotenv';
import path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

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

/**
 * Turnkey secret management. So a plain `docker compose up` works with almost
 * no configuration, the admin password, global API key, and session secret are
 * auto-generated on first boot and persisted to `<DATA_PATH>/.secrets.json`
 * (0600). Precedence per secret: explicit env var > previously persisted value
 * > freshly generated. Anything set in the environment always wins and is never
 * written to disk, so real deployments stay fully env-driven.
 *
 * Pure so it can be unit-tested; the file I/O wrapper below is thin.
 */
export function pickSecret(
  envValue: string | undefined,
  storedValue: string | undefined,
  generate: () => string,
): { value: string; generated: boolean } {
  if (envValue && envValue.trim()) return { value: envValue, generated: false };
  if (storedValue && String(storedValue).trim()) return { value: String(storedValue), generated: false };
  return { value: generate(), generated: true };
}

const SECRETS_FILE = path.join(DATA_PATH, '.secrets.json');

function loadOrGenerateManagedSecrets(): {
  adminUsername: string;
  adminPassword: string;
  apiKey: string;
  sessionSecret: string;
  generated: string[];
} {
  let stored: Record<string, string> = {};
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')) as Record<string, string>;
    }
  } catch {
    stored = {};
  }

  const generated: string[] = [];
  const take = (envValue: string | undefined, key: string, generate: () => string): string => {
    const result = pickSecret(envValue, stored[key], generate);
    if (result.generated) {
      stored[key] = result.value;
      generated.push(key);
    }
    return result.value;
  };

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = take(process.env.ADMIN_PASSWORD, 'adminPassword', () => crypto.randomBytes(12).toString('base64url'));
  const apiKey = take(process.env.DUCKLING_API_KEY, 'apiKey', () => `dk_root_${crypto.randomBytes(24).toString('base64url')}`);
  const sessionSecret = take(
    process.env.SESSION_SECRET || process.env.JWT_SECRET,
    'sessionSecret',
    () => crypto.randomBytes(32).toString('hex'),
  );

  // In tests, resolve secrets in memory but never touch disk or print — avoids
  // polluting ./data and leaking generated values into test output.
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

  if (generated.length > 0 && !isTest) {
    try {
      if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    } catch (error) {
      // Non-fatal: the process still runs with in-memory secrets, they just
      // won't survive a restart. Surface it so the operator can fix perms.
      console.warn(`[secrets] could not persist auto-generated secrets to ${SECRETS_FILE}:`, error);
    }
    // One-time notice (only on the boot that generated them) so the operator
    // can retrieve the credentials. They are also in <DATA_PATH>/.secrets.json.
    console.log(
      '\n========================================================================\n' +
      '  Duckling generated missing credentials on first boot (persisted to\n' +
      `  ${SECRETS_FILE}). Set these in the environment to manage them yourself.\n` +
      (generated.includes('adminPassword') ? `    ADMIN_USERNAME=${adminUsername}\n    ADMIN_PASSWORD=${adminPassword}\n` : '') +
      (generated.includes('apiKey') ? `    DUCKLING_API_KEY=${apiKey}\n` : '') +
      (generated.includes('sessionSecret') ? '    SESSION_SECRET=(generated 32-byte secret)\n' : '') +
      '========================================================================\n',
    );
  }

  return { adminUsername, adminPassword, apiKey, sessionSecret, generated };
}

const MANAGED_SECRETS = loadOrGenerateManagedSecrets();

/**
 * Parse TRUST_PROXY into a value Express `app.set('trust proxy', ...)` accepts.
 * Default is `false` (do NOT trust X-Forwarded-For) — trusting proxy headers
 * unconditionally is itself a spoofing vector, so it must be opted into.
 *   - unset / 'false' -> false       (use the socket peer; ignore XFF)
 *   - 'true'          -> true        (trust all hops — only behind a closed network)
 *   - '<n>'           -> n (number)  (trust n proxy hops closest to the server)
 *   - anything else   -> string      ('loopback', a CIDR, or comma list)
 */
const parseTrustProxy = (raw: string | undefined): boolean | number | string => {
  if (raw === undefined || raw.trim() === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  return raw.trim();
};

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
// Number of proxy hops the raw-socket paths (WebSocket) should trust in
// X-Forwarded-For. Defaults to the numeric TRUST_PROXY value when given, else
// 0 (don't trust XFF at all). Set TRUST_PROXY_HOPS explicitly when TRUST_PROXY
// is non-numeric (e.g. 'loopback' or a CIDR) but you still front with N proxies.
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS !== undefined
  ? Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS, 10) || 0)
  : (typeof TRUST_PROXY === 'number' ? TRUST_PROXY : 0);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),

  paths: {
    data: DATA_PATH,
    backups: process.env.BACKUP_PATH || path.join(DATA_PATH, 'backups'),
    metadata: path.join(DATA_PATH, 'metadata'),
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
    // Apply the `final = 1` query setting on all reads so ReplacingMergeTree
    // tables (PeerDB-mode destinations + internal watermark/session tables)
    // return fully-deduplicated state instead of whatever the background
    // merges have gotten to. No-op on plain MergeTree (polling-mode layout).
    // Requires ClickHouse >= 23.2. Disable for raw scan speed over
    // read-time consistency.
    finalReads: process.env.CLICKHOUSE_FINAL_READS !== 'false',
  },

  replication: {
    // Process-wide default for new databases when `replicationMode` isn't pinned
    // in `databases.json`. Per-database settings always win.
    //
    // Default: 'duckling' (polling backend). PeerDB is heavy — Temporal +
    // catalog Postgres + flow-api + flow-worker + flow-snapshot-worker + RustFS,
    // ~6 containers — and forcing it on every local boot is hostile for
    // dev/onboarding. Operators who want PeerDB by default set
    // `REPLICATION_BACKEND=peerdb` AND bring up the PeerDB stack with
    // `docker-compose -f docker-compose.peerdb.yml up -d`. The integration
    // suite always brings PeerDB up and exercises both modes.
    backend: process.env.REPLICATION_BACKEND === 'peerdb' ? 'peerdb' : 'duckling',
  },

  peerdb: {
    enabled: process.env.PEERDB_ENABLED === 'true',
    apiUrl: process.env.PEERDB_API_URL || 'http://localhost:8113',
    uiUrl: process.env.PEERDB_UI_URL || 'http://localhost:3003',
    apiKey: process.env.PEERDB_API_KEY || '',
    sqlHost: process.env.PEERDB_SQL_HOST || 'localhost',
    sqlPort: parseInt(process.env.PEERDB_SQL_PORT || '9900'),
    sqlUser: process.env.PEERDB_SQL_USER || 'peerdb',
    sqlPassword: process.env.PEERDB_SQL_PASSWORD || 'peerdb',
    sqlDatabase: process.env.PEERDB_SQL_DATABASE || 'peerdb',
    sourcePeerPrefix: process.env.PEERDB_SOURCE_PEER_PREFIX || 'mysql',
    targetPeerPrefix: process.env.PEERDB_TARGET_PEER_PREFIX || 'clickhouse',
    mirrorPrefix: process.env.PEERDB_MIRROR_PREFIX || 'duckling',
    clickhouseHost: process.env.PEERDB_CLICKHOUSE_HOST || 'clickhouse',
    clickhousePort: parseInt(process.env.PEERDB_CLICKHOUSE_PORT || '9000'),
    clickhouseTls: process.env.PEERDB_CLICKHOUSE_TLS === 'true',
    defaultFlowJobNamePrefix: process.env.PEERDB_FLOW_JOB_PREFIX || 'duckling',
    mysqlDisableTls: process.env.PEERDB_MYSQL_DISABLE_TLS !== 'false',
    mysqlFlavor: process.env.PEERDB_MYSQL_FLAVOR || 'mysql',
    mysqlReplicationMechanism: process.env.PEERDB_MYSQL_REPLICATION_MECHANISM || 'auto',
    mysqlSetup: process.env.PEERDB_MYSQL_SETUP || 'set names utf8mb4',
  },

  rustfs: {
    endpoint: process.env.RUSTFS_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || 'http://localhost:9000',
    accessKeyId: process.env.RUSTFS_ACCESS_KEY || process.env.RUSTFS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.RUSTFS_SECRET_KEY || process.env.RUSTFS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.RUSTFS_REGION || process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.RUSTFS_BUCKET || process.env.PEERDB_S3_BUCKET || 'peerdb-stage',
    usePathStyle: process.env.RUSTFS_USE_PATH_STYLE !== 'false',
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
    // Express `trust proxy` value; governs how req.ip / X-Forwarded-For is
    // resolved for HTTP (and therefore IP-based rate limiting).
    trustProxy: TRUST_PROXY,
    // Trusted proxy hop count for raw-socket paths (WebSocket IP extraction).
    trustProxyHops: TRUST_PROXY_HOPS,
  },

  auth: {
    // Auto-generated + persisted on first boot when the corresponding env var
    // is unset (see loadOrGenerateManagedSecrets). Env always wins.
    adminUsername: MANAGED_SECRETS.adminUsername,
    adminPassword: MANAGED_SECRETS.adminPassword,
    sessionSecret: MANAGED_SECRETS.sessionSecret,
    apiKey: MANAGED_SECRETS.apiKey,
    jwtSecret: process.env.JWT_SECRET || MANAGED_SECRETS.sessionSecret,
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
