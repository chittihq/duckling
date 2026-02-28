import { describe, it, expect } from 'vitest';
import { QueryGovernor, QueryQueueFullError, QueryTimeoutError } from '../queryGovernor';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('QueryGovernor', () => {
  it('rejects when queue is saturated', async () => {
    const governor = new QueryGovernor({ maxConcurrentQueries: 1, queueMax: 1, timeoutMs: 1000 });
    const inFlight = governor.execute(async () => {
      await sleep(50);
      return 'first';
    });

    const queued = governor.execute(async () => 'second');

    await expect(governor.execute(async () => 'third')).rejects.toBeInstanceOf(QueryQueueFullError);
    await expect(inFlight).resolves.toBe('first');
    await expect(queued).resolves.toBe('second');
  });

  it('times out long-running work', async () => {
    const governor = new QueryGovernor({ maxConcurrentQueries: 1, queueMax: 1, timeoutMs: 10 });
    await expect(
      governor.execute(async () => {
        await sleep(30);
        return 'done';
      })
    ).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('prevents starvation with weighted fairness', async () => {
    const governor = new QueryGovernor({
      maxConcurrentQueries: 1,
      queueMax: 10,
      timeoutMs: 1000,
      maxConsecutiveHighPriority: 1
    });
    const executionOrder: string[] = [];

    const blocker = governor.execute(async () => {
      await sleep(30);
      executionOrder.push('blocker');
      return 'blocker';
    });

    const high1 = governor.execute(async () => {
      executionOrder.push('high1');
      return 'high1';
    }, { priority: 'high' });

    const normal = governor.execute(async () => {
      executionOrder.push('normal');
      return 'normal';
    });

    const high2 = governor.execute(async () => {
      executionOrder.push('high2');
      return 'high2';
    }, { priority: 'high' });

    await Promise.all([blocker, high1, normal, high2]);

    expect(executionOrder.slice(1)).toEqual(['high1', 'normal', 'high2']);
  });
});

