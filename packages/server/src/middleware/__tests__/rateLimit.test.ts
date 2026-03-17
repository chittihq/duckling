import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import config from '../../config';
import {
  __resetRateLimitStateForTests,
  classifyEndpoint,
  checkRateLimit,
  identifyClient,
  postAuthRateLimiter,
} from '../rateLimit';

type AnyReq = any;

class MockResponse {
  public headers: Record<string, any> = {};
  public statusCode: number = 200;
  public body: any = null;
  private listeners: Record<string, Array<(...args: any[]) => void>> = {};

  setHeader(name: string, value: any): this {
    this.headers[name] = value;
    return this;
  }

  getHeader(name: string): any {
    return this.headers[name];
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: any): this {
    this.body = payload;
    return this;
  }

  on(event: string, cb: (...args: any[]) => void): this {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(cb);
    return this;
  }

  off(event: string, cb: (...args: any[]) => void): this {
    this.listeners[event] = (this.listeners[event] || []).filter(listener => listener !== cb);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.listeners[event] || []) {
      listener();
    }
  }
}

const originalRateLimitConfig = JSON.parse(JSON.stringify(config.rateLimit));

function buildReq(overrides: Partial<AnyReq> = {}): AnyReq {
  return {
    method: 'GET',
    path: '/api/tables',
    headers: {},
    ip: '127.0.0.1',
    query: {},
    params: {},
    body: {},
    user: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitStateForTests();

  config.rateLimit.enabled = true;
  config.rateLimit.mode = 'enforce';
  config.rateLimit.identity.useSessionScope = false;
  config.rateLimit.identity.includeDatabaseScope = true;
  config.rateLimit.tiers.anonymous = 1;
  config.rateLimit.tiers.jwt = 1;
  config.rateLimit.tiers.apiKey = 1;
  config.rateLimit.categories.auth.maxRequests = 10;
  config.rateLimit.categories.read.maxRequests = 60;
  config.rateLimit.categories.query.maxRequests = 20;
  config.rateLimit.categories.write.maxRequests = 10;
  config.rateLimit.categories.monitoring.maxRequests = 120;
  config.rateLimit.costs.auth = 1;
  config.rateLimit.costs.read = 1;
  config.rateLimit.costs.query = 5;
  config.rateLimit.costs.write = 3;
  config.rateLimit.costs.monitoring = 1;
  config.rateLimit.queryConcurrency.enabled = true;
  config.rateLimit.queryConcurrency.anonymousMaxInFlight = 1;
  config.rateLimit.queryConcurrency.jwtMaxInFlight = 1;
  config.rateLimit.queryConcurrency.apiKeyMaxInFlight = 2;
  config.rateLimit.queryConcurrency.staleEntryTtlMs = 300000;
});

afterEach(() => {
  Object.assign(config.rateLimit, JSON.parse(JSON.stringify(originalRateLimitConfig)));
  __resetRateLimitStateForTests();
});

describe('rateLimit identity', () => {
  test('defaults JWT key to username scope (no jti)', () => {
    const req = buildReq({
      user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' },
      query: { db: 'tenant_a' },
    });

    const id = identifyClient(req);

    expect(id.tier).toBe('jwt');
    expect(id.key).toContain('user:admin');
    expect(id.key).not.toContain('session:');
  });

  test('uses username + session jti + db scope for logged in JWT users', () => {
    config.rateLimit.identity.useSessionScope = true;

    const req1 = buildReq({
      user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' },
      query: { db: 'tenant_a' },
    });
    const req2 = buildReq({
      user: { username: 'admin', jti: 'session-b', authMethod: 'jwt' },
      query: { db: 'tenant_a' },
    });

    const id1 = identifyClient(req1);
    const id2 = identifyClient(req2);

    expect(id1.tier).toBe('jwt');
    expect(id2.tier).toBe('jwt');
    expect(id1.key).toContain('user:admin');
    expect(id1.key).toContain('session:session-a');
    expect(id1.key).toContain('db:tenant_a');
    expect(id2.key).toContain('session:session-b');
    expect(id1.key).not.toBe(id2.key);
  });

  test('uses req.ip instead of trusting x-forwarded-for directly', () => {
    const req = buildReq({
      headers: { 'x-forwarded-for': '203.0.113.10' },
      ip: '10.0.0.5',
    });

    const id = identifyClient(req);

    expect(id.tier).toBe('anonymous');
    expect(id.key).toContain('ip:10.0.0.5');
    expect(id.key).not.toContain('203.0.113.10');
  });

  test('defaults database scope for routes that attach database context', () => {
    const req = buildReq({
      path: '/sync/full',
      user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' },
    });

    const id = identifyClient(req);

    expect(id.key).toContain('db:default');
  });

  test('does not add a fake database scope to non-database routes', () => {
    const req = buildReq({
      path: '/api/logs',
      query: { db: 'tenant_a' },
      user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' },
    });

    const id = identifyClient(req);

    expect(id.key).not.toContain('db:default');
  });
});

describe('rateLimit weighted counters', () => {
  test('applies weighted cost to query limits', () => {
    config.rateLimit.categories.query.maxRequests = 10;
    config.rateLimit.costs.query = 5;

    const one = checkRateLimit('user:admin:session:a', 'query', 'jwt', 5, 1_000);
    const two = checkRateLimit('user:admin:session:a', 'query', 'jwt', 5, 1_001);
    const three = checkRateLimit('user:admin:session:a', 'query', 'jwt', 1, 1_002);

    expect(one.limited).toBe(false);
    expect(two.limited).toBe(false);
    expect(three.limited).toBe(true);
  });
});

describe('rateLimit modes', () => {
  test('shadow mode does not mutate counters after would-block threshold', () => {
    config.rateLimit.mode = 'shadow';
    config.rateLimit.categories.read.maxRequests = 1;

    const first = checkRateLimit('user:admin', 'read', 'jwt', 1, 1_000);
    const second = checkRateLimit('user:admin', 'read', 'jwt', 1, 1_001);
    const third = checkRateLimit('user:admin', 'read', 'jwt', 1, 1_002);

    expect(first.wouldLimit).toBe(false);
    expect(second.wouldLimit).toBe(true);
    expect(third.wouldLimit).toBe(true);
    expect(second.used).toBe(1);
    expect(third.used).toBe(1);
  });

  test('shadow mode sets would-block header but does not reject', () => {
    config.rateLimit.mode = 'shadow';
    config.rateLimit.categories.read.maxRequests = 1;
    config.rateLimit.costs.read = 1;

    const req = buildReq({ user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' } });

    const res1 = new MockResponse();
    let nextCount = 0;
    postAuthRateLimiter(req, res1 as any, () => { nextCount += 1; });

    const res2 = new MockResponse();
    postAuthRateLimiter(req, res2 as any, () => { nextCount += 1; });

    expect(nextCount).toBe(2);
    expect(res2.statusCode).toBe(200);
    expect(res2.getHeader('X-RateLimit-Shadow-Would-Block')).toBe('true');
  });
});

describe('query concurrency', () => {
  test('enforces per-identity in-flight query cap', () => {
    config.rateLimit.mode = 'enforce';
    config.rateLimit.queryConcurrency.enabled = true;
    config.rateLimit.queryConcurrency.jwtMaxInFlight = 1;

    const req = buildReq({
      method: 'POST',
      path: '/api/query',
      body: { sql: 'SELECT 1' },
      user: { username: 'admin', jti: 'session-a', authMethod: 'jwt' },
    });

    const res1 = new MockResponse();
    let firstNextCalled = false;
    postAuthRateLimiter(req, res1 as any, () => { firstNextCalled = true; });
    expect(firstNextCalled).toBe(true);

    const res2 = new MockResponse();
    let secondNextCalled = false;
    postAuthRateLimiter(req, res2 as any, () => { secondNextCalled = true; });
    expect(secondNextCalled).toBe(false);
    expect(res2.statusCode).toBe(429);
    expect(res2.body?.concurrencyLimit).toBe(1);
    expect(res2.body?.inFlight).toBe(1);
    expect(res2.getHeader('X-RateLimit-Query-Concurrency-Limit')).toBe(1);
    expect(res2.getHeader('X-RateLimit-Query-Concurrency-In-Flight')).toBe(1);

    res1.emit('finish');

    const res3 = new MockResponse();
    let thirdNextCalled = false;
    postAuthRateLimiter(req, res3 as any, () => { thirdNextCalled = true; });
    expect(thirdNextCalled).toBe(true);
  });
});

describe('route classification', () => {
  test('classifies previously uncovered protected endpoints', () => {
    expect(classifyEndpoint('GET', '/api/metrics/system')).toBe('monitoring');
    expect(classifyEndpoint('GET', '/api/governor/stats')).toBe('monitoring');
    expect(classifyEndpoint('GET', '/api/workers/stats')).toBe('monitoring');
    expect(classifyEndpoint('GET', '/api/databases/tenant_a/diagnose/stream')).toBe('monitoring');
    expect(classifyEndpoint('GET', '/api/replica/status')).toBe('read');
    expect(classifyEndpoint('POST', '/api/databases/tenant_a/s3/test')).toBe('write');
  });
});
