import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../logger';

// --- Types ---

type RateLimitCategory = 'auth' | 'read' | 'query' | 'write' | 'monitoring';
type ClientTier = 'anonymous' | 'jwt' | 'apiKey';

interface RateLimitBucket {
  currentCount: number;
  previousCount: number;
  windowStart: number;
}

interface RateLimitResult {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAt: number;    // Unix timestamp (seconds)
  retryAfterSec: number;
}

// --- In-memory store ---

const store = new Map<string, RateLimitBucket>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// --- Endpoint classification ---

export function classifyEndpoint(method: string, path: string): RateLimitCategory | null {
  // Exempt paths
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

  // Auth endpoints
  if (
    path === '/api/login' ||
    path === '/api/logout' ||
    path === '/api/check-auth'
  ) {
    return 'auth';
  }

  // Monitoring endpoints
  if (
    path === '/health' ||
    path === '/status' ||
    path === '/metrics'
  ) {
    return 'monitoring';
  }

  // Query endpoints (POST only)
  if (
    upperMethod === 'POST' &&
    (path === '/api/query' || path === '/api/validation/table-details')
  ) {
    return 'query';
  }

  // Read endpoints (GET requests to data paths)
  if (upperMethod === 'GET') {
    if (
      path.startsWith('/api/tables') ||
      path === '/api/databases' ||
      path === '/api/logs' ||
      path.startsWith('/api/sync-logs') ||
      path.startsWith('/api/backups') ||
      path.startsWith('/sync/') ||
      path.startsWith('/automation/') ||
      path.startsWith('/cdc/') ||
      path.startsWith('/api/validation/')
    ) {
      return 'read';
    }
  }

  // Write endpoints (POST/PUT/DELETE to mutating paths)
  if (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'DELETE') {
    if (
      path.startsWith('/sync/') ||
      path.startsWith('/automation/') ||
      path.startsWith('/cdc/') ||
      path.startsWith('/api/databases') ||
      path.startsWith('/api/backups') ||
      path.startsWith('/api/validation/')
    ) {
      return 'write';
    }
  }

  // Not rate-limited (SPA catch-all, unknown routes)
  return null;
}

// --- Client identification ---

export function identifyClient(req: Request): { key: string; tier: ClientTier } {
  // If user is authenticated, use identity-based key
  if (req.user?.username) {
    const tier: ClientTier = req.user.username === 'api-key-user' ? 'apiKey' : 'jwt';
    return { key: `user:${req.user.username}`, tier };
  }

  // Fall back to IP-based key
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  return { key: `ip:${ip}`, tier: 'anonymous' };
}

// --- Sliding window counter ---

export function checkRateLimit(clientKey: string, category: RateLimitCategory, tier: ClientTier): RateLimitResult {
  const categoryConfig = config.rateLimit.categories[category];
  const windowMs = categoryConfig.windowMs;
  const baseMax = categoryConfig.maxRequests;
  const multiplier = config.rateLimit.tiers[tier];
  const limit = Math.floor(baseMax * multiplier);

  const now = Date.now();
  const bucketKey = `${clientKey}:${category}`;

  let bucket = store.get(bucketKey);

  if (!bucket) {
    bucket = { currentCount: 0, previousCount: 0, windowStart: now };
    store.set(bucketKey, bucket);
  }

  // Check if we've moved into a new window
  const elapsed = now - bucket.windowStart;

  if (elapsed >= windowMs * 2) {
    // More than 2 windows have passed — reset completely
    bucket.previousCount = 0;
    bucket.currentCount = 0;
    bucket.windowStart = now;
  } else if (elapsed >= windowMs) {
    // Rolled into a new window
    bucket.previousCount = bucket.currentCount;
    bucket.currentCount = 0;
    bucket.windowStart = bucket.windowStart + windowMs;
  }

  // Interpolated effective count
  const elapsedInWindow = now - bucket.windowStart;
  const elapsedFraction = elapsedInWindow / windowMs;
  const effectiveCount = bucket.previousCount * (1 - elapsedFraction) + bucket.currentCount;

  const resetAt = Math.ceil((bucket.windowStart + windowMs) / 1000);
  const remaining = Math.max(0, Math.floor(limit - effectiveCount));

  if (effectiveCount >= limit) {
    const retryAfterSec = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
    return {
      limited: true,
      limit,
      remaining: 0,
      resetAt,
      retryAfterSec: Math.max(1, retryAfterSec),
    };
  }

  // Allow the request — increment current window
  bucket.currentCount++;

  return {
    limited: false,
    limit,
    remaining: Math.max(0, remaining - 1),
    resetAt,
    retryAfterSec: 0,
  };
}

// --- Response headers ---

export function setRateLimitHeaders(res: Response, info: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', info.limit);
  res.setHeader('X-RateLimit-Remaining', info.remaining);
  res.setHeader('X-RateLimit-Reset', info.resetAt);
  if (info.limited) {
    res.setHeader('Retry-After', info.retryAfterSec);
  }
}

// --- Pre-auth middleware (IP-based, for auth + monitoring) ---

export function preAuthRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimit.enabled) {
    next();
    return;
  }

  const category = classifyEndpoint(req.method, req.path);

  // Only handle auth and monitoring here (IP-based, before auth runs)
  if (category !== 'auth' && category !== 'monitoring') {
    next();
    return;
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  const clientKey = `ip:${ip}`;

  // For pre-auth, always use anonymous tier
  const result = checkRateLimit(clientKey, category, 'anonymous');
  setRateLimitHeaders(res, result);

  if (result.limited) {
    logger.warn(`Rate limit exceeded: ${clientKey} on ${category}`, {
      ip,
      path: req.path,
      category,
      limit: result.limit,
    });

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${result.retryAfterSec} seconds.`,
      retryAfter: result.retryAfterSec,
      limit: result.limit,
      category,
    });
    return;
  }

  next();
}

// --- Post-auth middleware (identity-based, for read/query/write) ---

export function postAuthRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimit.enabled) {
    next();
    return;
  }

  const category = classifyEndpoint(req.method, req.path);

  // Skip categories already handled by preAuth, and exempt routes
  if (!category || category === 'auth' || category === 'monitoring') {
    next();
    return;
  }

  const { key, tier } = identifyClient(req);
  const result = checkRateLimit(key, category, tier);
  setRateLimitHeaders(res, result);

  if (result.limited) {
    logger.warn(`Rate limit exceeded: ${key} on ${category}`, {
      path: req.path,
      category,
      tier,
      limit: result.limit,
    });

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${result.retryAfterSec} seconds.`,
      retryAfter: result.retryAfterSec,
      limit: result.limit,
      category,
    });
    return;
  }

  next();
}

// --- Cleanup stale entries ---

export function startRateLimitCleanup(): void {
  const intervalMs = config.rateLimit.cleanupIntervalMs;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let removed = 0;

    for (const [key, bucket] of store) {
      // Determine the window size from the category embedded in the key
      // Key format: "ip:xxx:category" or "user:xxx:category"
      const category = key.split(':').pop() as RateLimitCategory;
      const categoryConfig = config.rateLimit.categories[category];
      const windowMs = categoryConfig?.windowMs ?? 60000;

      // Remove if older than 2 full windows
      if (now - bucket.windowStart > windowMs * 2) {
        store.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`Rate limit cleanup: removed ${removed} stale entries, ${store.size} remaining`);
    }
  }, intervalMs);
}

export function stopRateLimitCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  store.clear();
}
