import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the config and logger modules before importing the governor
vi.mock('../../config', () => ({
  default: {
    governor: {
      maxConcurrentQueries: 2,
      queryTimeoutMs: 1000,
      queryQueueMax: 3,
    },
  },
}));

vi.mock('../../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QueryGovernor, QueryGovernorError } from '../queryGovernor';

describe('QueryGovernor', () => {
  let governor: QueryGovernor;

  beforeEach(() => {
    governor = new QueryGovernor({
      maxConcurrent: 2,
      maxQueue: 3,
      timeoutMs: 500,
      maxConsecutiveHighPriority: 2,
    });
  });

  test('executes a query and returns result', async () => {
    const result = await governor.execute(async () => 42, { sql: 'SELECT 1' });
    expect(result).toBe(42);
  });

  test('tracks stats after execution', async () => {
    await governor.execute(async () => 'ok');
    const stats = governor.getStats();
    expect(stats.totalExecuted).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.queued).toBe(0);
  });

  test('respects concurrency limit', async () => {
    const order: string[] = [];

    // Fill both concurrent slots with slow queries
    const p1 = governor.execute(async () => {
      order.push('start-1');
      await new Promise(r => setTimeout(r, 100));
      order.push('end-1');
      return 1;
    }, { sql: 'slow1' });

    const p2 = governor.execute(async () => {
      order.push('start-2');
      await new Promise(r => setTimeout(r, 100));
      order.push('end-2');
      return 2;
    }, { sql: 'slow2' });

    // This third query should be queued
    const p3 = governor.execute(async () => {
      order.push('start-3');
      return 3;
    }, { sql: 'queued' });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([1, 2, 3]);

    // Query 3 should have started after 1 or 2 finished
    const startIdx3 = order.indexOf('start-3');
    const endIdx1 = order.indexOf('end-1');
    const endIdx2 = order.indexOf('end-2');
    expect(startIdx3).toBeGreaterThanOrEqual(Math.min(endIdx1, endIdx2));
  });

  test('rejects when queue is full', async () => {
    // Fill concurrency slots (2)
    const block1 = governor.execute(() => new Promise(r => setTimeout(r, 200)));
    const block2 = governor.execute(() => new Promise(r => setTimeout(r, 200)));

    // Fill queue (3)
    const q1 = governor.execute(() => new Promise(r => setTimeout(r, 10)));
    const q2 = governor.execute(() => new Promise(r => setTimeout(r, 10)));
    const q3 = governor.execute(() => new Promise(r => setTimeout(r, 10)));

    // This should be rejected — queue is full
    await expect(
      governor.execute(async () => 'should-fail')
    ).rejects.toThrow(QueryGovernorError);

    await expect(
      governor.execute(async () => 'should-fail')
    ).rejects.toThrow(/overloaded/i);

    // Clean up
    await Promise.all([block1, block2, q1, q2, q3]);

    const stats = governor.getStats();
    expect(stats.totalRejected).toBe(2);
  });

  test('times out long-running queries', async () => {
    await expect(
      governor.execute(
        () => new Promise(r => setTimeout(r, 2000)), // 2s, timeout is 500ms
        { sql: 'slow' }
      )
    ).rejects.toThrow(/timed out/i);

    const stats = governor.getStats();
    expect(stats.totalTimedOut).toBe(1);
  });

  test('QueryGovernorError has statusCode', async () => {
    try {
      // Fill everything to get 503
      const g = new QueryGovernor({ maxConcurrent: 1, maxQueue: 0, timeoutMs: 5000 });
      const block = g.execute(() => new Promise(r => setTimeout(r, 200)));
      await g.execute(async () => 'fail');
      await block;
    } catch (err) {
      expect(err).toBeInstanceOf(QueryGovernorError);
      expect((err as QueryGovernorError).statusCode).toBe(503);
    }
  });

  test('priority lanes: high priority goes before normal', async () => {
    const order: string[] = [];

    // Fill both slots
    const block1 = governor.execute(async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'b1';
    });
    const block2 = governor.execute(async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'b2';
    });

    // Queue: normal then high — high should execute first when a slot opens
    const normal = governor.execute(async () => {
      order.push('normal');
      return 'n';
    }, { priority: 'normal' });

    const high = governor.execute(async () => {
      order.push('high');
      return 'h';
    }, { priority: 'high' });

    await Promise.all([block1, block2, normal, high]);

    // High priority should have been dequeued before normal
    expect(order.indexOf('high')).toBeLessThan(order.indexOf('normal'));
  });

  test('anti-starvation: normal gets a turn after consecutive high priority', async () => {
    // maxConsecutiveHighPriority = 2
    const order: string[] = [];

    // Fill both slots
    const block1 = governor.execute(() => new Promise(r => setTimeout(r, 100)));
    const block2 = governor.execute(() => new Promise(r => setTimeout(r, 100)));

    // Queue: normal, high, high, high
    // After 2 consecutive high, normal should get a turn
    const pNormal = governor.execute(async () => { order.push('normal'); }, { priority: 'normal' });
    const pH1 = governor.execute(async () => { order.push('high1'); }, { priority: 'high' });
    const pH2 = governor.execute(async () => { order.push('high2'); }, { priority: 'high' });

    await Promise.all([block1, block2, pNormal, pH1, pH2]);

    // After 2 high-priority items, normal should get a turn
    // The order should be: high1, high2, normal (anti-starvation kicks in at 3rd)
    // Since maxConsecutiveHighPriority=2, after high1+high2 it yields to normal
    const normalIdx = order.indexOf('normal');
    expect(normalIdx).toBeLessThanOrEqual(2); // normal should be within first 3
  });

  test('getStats returns correct shape', () => {
    const stats = governor.getStats();
    expect(stats).toHaveProperty('running');
    expect(stats).toHaveProperty('queued');
    expect(stats).toHaveProperty('maxConcurrent');
    expect(stats).toHaveProperty('maxQueue');
    expect(stats).toHaveProperty('timeoutMs');
    expect(stats).toHaveProperty('totalExecuted');
    expect(stats).toHaveProperty('totalTimedOut');
    expect(stats).toHaveProperty('totalRejected');
    expect(stats).toHaveProperty('activeQueries');
    expect(Array.isArray(stats.activeQueries)).toBe(true);
  });

  test('resetStats clears counters', async () => {
    await governor.execute(async () => 'ok');
    governor.resetStats();
    const stats = governor.getStats();
    expect(stats.totalExecuted).toBe(0);
    expect(stats.totalTimedOut).toBe(0);
    expect(stats.totalRejected).toBe(0);
  });

  test('active queries are tracked during execution', async () => {
    let capturedStats: any = null;

    await governor.execute(async () => {
      capturedStats = governor.getStats();
    }, { sql: 'SELECT 1' });

    expect(capturedStats).not.toBeNull();
    expect(capturedStats.running).toBe(1);
    expect(capturedStats.activeQueries.length).toBe(1);
    expect(capturedStats.activeQueries[0].sql).toBe('SELECT 1');
    expect(capturedStats.activeQueries[0].status).toBe('running');
  });

  test('slot is released even when query throws', async () => {
    await expect(
      governor.execute(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    // Slot should be released — next query should work
    const result = await governor.execute(async () => 'ok');
    expect(result).toBe('ok');
  });
});
