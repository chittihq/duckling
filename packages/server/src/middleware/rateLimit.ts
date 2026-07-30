import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../logger';

type RateLimitCategory = 'auth' | 'read' | 'query' | 'write' | 'monitoring';
type ClientTier = 'anonymous' | 'jwt' | 'apiKey';
type RateLimitMode = 'shadow' | 'enforce';

interface RateLimitBucket {
  currentCost: number;
  previousCost: number;
  windowStart: number;
}

interface RateLimitResult {
  limited: boolean;
  wouldLimit: boolean;
  shadow: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
  cost: number;
}

interface QueryConcurrencyResult {
  limited: boolean;
  shadow: boolean;
  maxInFlight: number;
  inFlight: number;
  release: () => void;
}

interface QueryInFlightEntry {
  count: number;
  updatedAt: number;
}

const store = new Map<string, RateLimitBucket>();
const queryInFlightStore = new Map<string, QueryInFlightEntry>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function getRateLimitMode(): RateLimitMode {
  return config.rateLimit.mode === 'shadow' ? 'shadow' : 'enforce';
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function usesDatabaseContextPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/status' ||
    path === '/api/query' ||
    path.startsWith('/sync/') ||
    path.startsWith('/automation/') ||
    path.startsWith('/cdc/') ||
    path.startsWith('/api/tables') ||
    path.startsWith('/api/backups') ||
    path.startsWith('/api/replica/') ||
    path.startsWith('/api/validation/')
  );
}

function isMonitoringPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/status' ||
    path === '/metrics' ||
    path === '/api/check-auth' ||
    path === '/api/logout' ||
    path === '/api/logs' ||
    path === '/api/sync-logs' ||
    path.startsWith('/api/metrics/') ||
    path.startsWith('/api/governor/') ||
    path.startsWith('/api/workers/') ||
    path.endsWith('/diagnose/stream')
  );
}

function isProtectedOperationalPath(path: string): boolean {
  return (
    path.startsWith('/api/') ||
    path.startsWith('/sync/') ||
    path.startsWith('/automation/') ||
    path.startsWith('/cdc/') ||
    path === '/health' ||
    path === '/status' ||
    path === '/metrics'
  );
}

function getRequestDatabaseScope(req: Request): string | null {
  if (!config.rateLimit.identity.includeDatabaseScope) {
    return null;
  }

  const queryDb = typeof req.query?.db === 'string' ? req.query.db : null;
  const headerDb = typeof req.headers['x-database-id'] === 'string' ? req.headers['x-database-id'] : null;
  const paramDb = req.path.startsWith('/api/databases/') && typeof req.params?.id === 'string'
    ? req.params.id
    : null;

  if (paramDb) {
    return sanitizeKeyPart(paramDb);
  }

  if (usesDatabaseContextPath(req.path)) {
    return sanitizeKeyPart(queryDb || headerDb || 'default');
  }

  return null;
}

function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// --- Endpoint classification ---

export function classifyEndpoint(method: string, path: string): RateLimitCategory | null {
  if (
    path.startsWith('/_nuxt/') ||
    path === '/openapi.json' ||
    path.endsWith('.js') ||
    path.endsWith('.css') ||
    path.endsWith('.ico') ||
    path.endsWith('.png') ||
    path.endsWith('.jpg') ||
    path.endsWith('.svg') ||
    path.endsWith('.woff') ||
    path.endsWith('.woff2') ||
    path.endsWith('.ttf') ||
    path.endsWith('.map')
  ) {
    return null;
  }

  const upperMethod = method.toUpperCase();

  // Only the credential-issuing endpoint gets the strict brute-force budget.
  // /api/check-auth and /api/logout are cheap session bookkeeping the
  // dashboard calls on every navigation — they classify as monitoring below.
  if (path === '/api/login') {
    return 'auth';
  }

  if (isMonitoringPath(path)) {
    return 'monitoring';
  }

  if (
    upperMethod === 'POST' &&
    (path === '/api/query' || path === '/api/validation/table-details')
  ) {
    return 'query';
  }

  if ((upperMethod === 'GET' || upperMethod === 'HEAD') && isProtectedOperationalPath(path)) {
    return 'read';
  }

  if (
    (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'DELETE' || upperMethod === 'PATCH') &&
    isProtectedOperationalPath(path)
  ) {
    return 'write';
  }

  return null;
}

// --- Client identification ---

export function identifyClient(req: Request): { key: string; tier: ClientTier } {
  let key: string;
  let tier: ClientTier;

  if (req.user?.username) {
    if (req.user.authMethod === 'apiKey' || req.user.username === 'api-key-user') {
      const apiKeyId = sanitizeKeyPart(req.user.apiKeyId || 'default');
      key = `apiKey:${apiKeyId}`;
      tier = 'apiKey';
    } else {
      const username = sanitizeKeyPart(req.user.username);
      const sessionScope = config.rateLimit.identity.useSessionScope
        ? `:session:${sanitizeKeyPart(req.user.jti || 'legacy')}`
        : '';
      key = `user:${username}${sessionScope}`;
      tier = 'jwt';
    }
  } else {
    key = `ip:${sanitizeKeyPart(getClientIp(req))}`;
    tier = 'anonymous';
  }

  const dbScope = getRequestDatabaseScope(req);
  if (dbScope) {
    key = `${key}:db:${dbScope}`;
  }

  return { key, tier };
}

function resolveRequestCost(category: RateLimitCategory, req: Request): number {
  let cost = config.rateLimit.costs[category] || 1;

  if (category === 'query') {
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
    if (sql.length > 5000) {
      cost += 2;
    } else if (sql.length > 2000) {
      cost += 1;
    }
  }

  return Math.max(1, cost);
}

// --- Sliding window with weighted costs ---

export function checkRateLimit(
  clientKey: string,
  category: RateLimitCategory,
  tier: ClientTier,
  cost: number,
  now: number = Date.now()
): RateLimitResult {
  const categoryConfig = config.rateLimit.categories[category];
  const windowMs = categoryConfig.windowMs;
  const baseMax = categoryConfig.maxRequests;
  const multiplier = config.rateLimit.tiers[tier];
  const limit = Math.max(1, Math.floor(baseMax * multiplier));
  const mode = getRateLimitMode();
  const bucketKey = `${clientKey}:${category}`;

  let bucket = store.get(bucketKey);
  if (!bucket) {
    bucket = { currentCost: 0, previousCost: 0, windowStart: now };
    store.set(bucketKey, bucket);
  }

  const elapsed = now - bucket.windowStart;
  if (elapsed >= windowMs * 2) {
    bucket.previousCost = 0;
    bucket.currentCost = 0;
    bucket.windowStart = now;
  } else if (elapsed >= windowMs) {
    bucket.previousCost = bucket.currentCost;
    bucket.currentCost = 0;
    bucket.windowStart = bucket.windowStart + windowMs;
  }

  const elapsedInWindow = now - bucket.windowStart;
  const elapsedFraction = Math.max(0, Math.min(1, elapsedInWindow / windowMs));
  const effectiveCost = bucket.previousCost * (1 - elapsedFraction) + bucket.currentCost;
  const projectedCost = effectiveCost + cost;
  const wouldLimit = projectedCost > limit;

  // Shadow mode is read-only: observe "would block" without mutating counters.
  const shouldCount = !wouldLimit;
  if (shouldCount) {
    bucket.currentCost += cost;
  }

  const used = shouldCount ? projectedCost : effectiveCost;
  const remaining = Math.max(0, Math.floor(limit - used));
  const resetAt = Math.ceil((bucket.windowStart + windowMs) / 1000);
  const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));

  return {
    limited: mode === 'enforce' && wouldLimit,
    wouldLimit,
    shadow: mode === 'shadow' && wouldLimit,
    limit,
    used,
    remaining,
    resetAt,
    retryAfterSec,
    cost,
  };
}

function getQueryConcurrencyLimit(tier: ClientTier): number {
  if (tier === 'apiKey') {
    return config.rateLimit.queryConcurrency.apiKeyMaxInFlight;
  }
  if (tier === 'jwt') {
    return config.rateLimit.queryConcurrency.jwtMaxInFlight;
  }
  return config.rateLimit.queryConcurrency.anonymousMaxInFlight;
}

function acquireQueryConcurrencySlot(clientKey: string, tier: ClientTier): QueryConcurrencyResult {
  const mode = getRateLimitMode();
  const maxInFlight = getQueryConcurrencyLimit(tier);
  const key = `${clientKey}:query`;
  const now = Date.now();
  const staleTtlMs = config.rateLimit.queryConcurrency.staleEntryTtlMs;
  const existing = queryInFlightStore.get(key);
  const current =
    existing && now - existing.updatedAt <= staleTtlMs
      ? existing.count
      : 0;
  if (existing && current === 0) {
    queryInFlightStore.delete(key);
  }
  const wouldLimit = current >= maxInFlight;

  if (wouldLimit && mode === 'enforce') {
    return {
      limited: true,
      shadow: false,
      maxInFlight,
      inFlight: current,
      release: () => {},
    };
  }

  queryInFlightStore.set(key, { count: current + 1, updatedAt: now });
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    const currentEntry = queryInFlightStore.get(key);
    const next = (currentEntry?.count || 1) - 1;
    if (next <= 0) {
      queryInFlightStore.delete(key);
    } else {
      queryInFlightStore.set(key, { count: next, updatedAt: Date.now() });
    }
  };

  return {
    limited: mode === 'enforce' && wouldLimit,
    shadow: mode === 'shadow' && wouldLimit,
    maxInFlight,
    inFlight: current + 1,
    release,
  };
}

// --- Response headers ---

export function setRateLimitHeaders(res: Response, info: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', info.limit);
  res.setHeader('X-RateLimit-Remaining', info.remaining);
  res.setHeader('X-RateLimit-Reset', info.resetAt);
  res.setHeader('X-RateLimit-Cost', info.cost);

  // RFC-style headers for clients that support them
  res.setHeader('RateLimit-Limit', info.limit);
  res.setHeader('RateLimit-Remaining', info.remaining);
  res.setHeader('RateLimit-Reset', info.resetAt);

  if (info.shadow) {
    res.setHeader('X-RateLimit-Shadow-Would-Block', 'true');
  }

  if (info.limited) {
    res.setHeader('Retry-After', info.retryAfterSec);
  }
}

function send429(
  res: Response,
  result: RateLimitResult,
  category: RateLimitCategory,
  extra: Record<string, unknown> = {}
): void {
  res.status(429).json({
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${result.retryAfterSec} seconds.`,
    retryAfter: result.retryAfterSec,
    limit: result.limit,
    category,
    cost: result.cost,
    ...extra,
  });
}

// --- Failed-credential limiter (called from the auth middleware) ---

/**
 * Charge a presented-but-rejected token to the per-IP auth (brute-force)
 * bucket. Returns true when the attempt was over the limit and a 429 was
 * sent — the caller must not also send its 401. Requests with no credentials
 * at all are never charged here: only presented-and-rejected tokens count as
 * credential guessing.
 */
export function handleFailedAuthRateLimit(req: Request, res: Response): boolean {
  if (!config.rateLimit.enabled) {
    return false;
  }

  const clientKey = `ip:${sanitizeKeyPart(getClientIp(req))}`;
  const cost = Math.max(1, config.rateLimit.costs.auth || 1);
  const result = checkRateLimit(clientKey, 'auth', 'anonymous', cost);
  setRateLimitHeaders(res, result);

  if (result.limited) {
    send429(res, result, 'auth', { reason: 'invalid-credentials' });
    return true;
  }

  return false;
}

// --- Pre-auth middleware ---

/**
 * Session endpoints routed BEFORE the auth middleware and the post-auth
 * limiter (see setupRoutes): if they aren't charged here, they are never
 * charged at all.
 */
function isPreRouteSessionPath(path: string): boolean {
  return path === '/api/check-auth' || path === '/api/logout';
}

function requestHasCredentials(req: Request): boolean {
  return Boolean(req.headers.authorization) || typeof req.query?.token === 'string';
}

let proxyWarningLogged = false;

function warnIfProxyNotTrusted(req: Request): void {
  if (proxyWarningLogged || config.server.trustProxy) {
    return;
  }
  if (!req.headers['x-forwarded-for']) {
    return;
  }
  proxyWarningLogged = true;
  logger.warn(
    'Requests carry X-Forwarded-For but TRUST_PROXY is not set: rate limiting sees every client as the proxy IP, so all clients share one bucket. Set TRUST_PROXY (e.g. TRUST_PROXY=1) when running behind a reverse proxy.'
  );
}

export function preAuthRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimit.enabled) {
    next();
    return;
  }

  warnIfProxyNotTrusted(req);

  const category = classifyEndpoint(req.method, req.path);
  if (category !== 'auth' && category !== 'monitoring') {
    next();
    return;
  }

  // Monitoring requests that present credentials are deferred to the
  // post-auth limiter, which keys on the authenticated identity and applies
  // the tier multiplier instead of the shared per-IP anonymous bucket.
  // Invalid credentials are charged to the brute-force budget by
  // handleFailedAuthRateLimit in the auth middleware. Pre-route session
  // paths respond before the post-auth limiter runs, so they are always
  // charged here.
  if (
    category === 'monitoring' &&
    requestHasCredentials(req) &&
    !isPreRouteSessionPath(req.path)
  ) {
    next();
    return;
  }

  const clientKey = `ip:${sanitizeKeyPart(getClientIp(req))}`;
  const cost = resolveRequestCost(category, req);
  const result = checkRateLimit(clientKey, category, 'anonymous', cost);
  setRateLimitHeaders(res, result);

  if (result.wouldLimit) {
    logger.debug(`Rate limit threshold reached: ${clientKey} on ${category}`, {
      path: req.path,
      category,
      limit: result.limit,
      mode: getRateLimitMode(),
      shadow: result.shadow,
    });
  }

  if (result.limited) {
    send429(res, result, category);
    return;
  }

  next();
}

// --- Post-auth middleware ---

export function postAuthRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimit.enabled) {
    next();
    return;
  }

  // Monitoring is handled here for authenticated requests (deferred by the
  // pre-auth limiter) so a logged-in dashboard gets its identity-keyed,
  // tier-multiplied budget instead of the shared anonymous IP bucket.
  const category = classifyEndpoint(req.method, req.path);
  if (!category || category === 'auth') {
    next();
    return;
  }

  const { key, tier } = identifyClient(req);
  const cost = resolveRequestCost(category, req);
  const result = checkRateLimit(key, category, tier, cost);
  setRateLimitHeaders(res, result);

  if (result.wouldLimit) {
    logger.debug('Rate limit threshold reached', {
      path: req.path,
      category,
      tier,
      mode: getRateLimitMode(),
      shadow: result.shadow,
    });
  }

  if (result.limited) {
    send429(res, result, category, { tier });
    return;
  }

  if (category === 'query' && config.rateLimit.queryConcurrency.enabled) {
    const slot = acquireQueryConcurrencySlot(key, tier);
    if (slot.shadow) {
      res.setHeader('X-RateLimit-Shadow-Query-Concurrency-Would-Block', 'true');
      logger.debug('Query concurrency threshold reached (shadow)', {
        path: req.path,
        tier,
      });
    }

    if (slot.limited) {
      res.setHeader('Retry-After', 1);
      res.setHeader('X-RateLimit-Query-Concurrency-Limit', slot.maxInFlight);
      res.setHeader('X-RateLimit-Query-Concurrency-In-Flight', slot.inFlight);
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many concurrent queries. Please retry shortly.',
        category: 'query',
        concurrencyLimit: slot.maxInFlight,
        inFlight: slot.inFlight,
        tier,
      });
      return;
    }

    res.setHeader('X-RateLimit-Query-Concurrency-Limit', slot.maxInFlight);
    res.setHeader('X-RateLimit-Query-Concurrency-In-Flight', slot.inFlight);

    const release = () => {
      slot.release();
      res.off('finish', release);
      res.off('close', release);
    };
    res.on('finish', release);
    res.on('close', release);
  }

  next();
}

// --- Cleanup ---

export function startRateLimitCleanup(): void {
  if (cleanupTimer) {
    return;
  }

  const intervalMs = config.rateLimit.cleanupIntervalMs;
  const staleInFlightTtlMs = config.rateLimit.queryConcurrency.staleEntryTtlMs;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let removedWindowBuckets = 0;
    let removedInFlightSlots = 0;

    for (const [key, bucket] of store) {
      const category = key.split(':').pop() as RateLimitCategory;
      const categoryConfig = config.rateLimit.categories[category];
      const windowMs = categoryConfig?.windowMs ?? 60000;
      if (now - bucket.windowStart > windowMs * 2) {
        store.delete(key);
        removedWindowBuckets++;
      }
    }

    for (const [key, entry] of queryInFlightStore) {
      if (entry.count <= 0 || now - entry.updatedAt > staleInFlightTtlMs) {
        queryInFlightStore.delete(key);
        removedInFlightSlots++;
      }
    }

    if (removedWindowBuckets > 0 || removedInFlightSlots > 0) {
      logger.debug(
        `Rate limit cleanup: removed ${removedWindowBuckets} stale windows and ${removedInFlightSlots} stale in-flight slots; ${store.size} windows and ${queryInFlightStore.size} in-flight keys remain`
      );
    }
  }, intervalMs);
}

export function stopRateLimitCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  store.clear();
  queryInFlightStore.clear();
}

// Test helper
export function __resetRateLimitStateForTests(): void {
  store.clear();
  queryInFlightStore.clear();
  proxyWarningLogged = false;
}
