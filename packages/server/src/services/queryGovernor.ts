/**
 * Query Governor Service
 *
 * Provides query governance for ClickHouse-backed operations:
 * - Semaphore-based concurrency limiting (MAX_CONCURRENT_QUERIES)
 * - Per-query timeout (QUERY_TIMEOUT_MS)
 * - Queue with max depth and 503 when saturated (QUERY_QUEUE_MAX)
 * - Priority lanes: 'high' for sync/CDC, 'normal' for API queries
 * - Anti-starvation: max consecutive high-priority slots before yielding to normal
 * - Active query tracking for monitoring
 *
 * ClickHouse note: requests are bounded at the application layer. This governor
 * still provides value through concurrency limiting and backpressure when the
 * server is saturated.
 */

import logger from '../logger';
import config from '../config';

export type QueryPriority = 'high' | 'normal';

export interface QueryInfo {
  id: string;
  sql: string;
  priority: QueryPriority;
  startedAt: number;
  status: 'queued' | 'running';
}

interface QueueEntry {
  id: string;
  sql: string;
  priority: QueryPriority;
  resolve: (value: void) => void;
  reject: (reason: Error) => void;
  enqueuedAt: number;
}

export interface GovernorStats {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
  timeoutMs: number;
  totalExecuted: number;
  totalTimedOut: number;
  totalRejected: number;
  activeQueries: QueryInfo[];
}

export class QueryGovernor {
  private running: number = 0;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly maxConsecutiveHighPriority: number;

  private queue: QueueEntry[] = [];
  private activeQueries: Map<string, QueryInfo> = new Map();
  private consecutiveHighPriority: number = 0;
  private queryCounter: number = 0;

  // Stats
  private totalExecuted: number = 0;
  private totalTimedOut: number = 0;
  private totalRejected: number = 0;

  constructor(opts?: {
    maxConcurrent?: number;
    maxQueue?: number;
    timeoutMs?: number;
    maxConsecutiveHighPriority?: number;
  }) {
    this.maxConcurrent = opts?.maxConcurrent ?? config.governor.maxConcurrentQueries;
    this.maxQueue = opts?.maxQueue ?? config.governor.queryQueueMax;
    this.timeoutMs = opts?.timeoutMs ?? config.governor.queryTimeoutMs;
    this.maxConsecutiveHighPriority = opts?.maxConsecutiveHighPriority ?? 5;
  }

  /**
   * Execute a query function through the governor with concurrency control,
   * timeout, and priority-based scheduling.
   */
  async execute<T>(
    fn: () => Promise<T>,
    opts?: { sql?: string; priority?: QueryPriority; timeoutMs?: number }
  ): Promise<T> {
    const priority = opts?.priority ?? 'normal';
    const sql = opts?.sql ?? '<unknown>';
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const queryId = `q-${++this.queryCounter}`;

    // Check if queue is full — reject with 503-appropriate error
    if (this.running >= this.maxConcurrent && this.queue.length >= this.maxQueue) {
      this.totalRejected++;
      logger.warn(`Query governor: queue full (${this.queue.length}/${this.maxQueue}), rejecting query`);
      throw new QueryGovernorError(
        `Server overloaded: ${this.queue.length} queries queued, ${this.running} running. Try again later.`,
        503
      );
    }

    // Wait for a slot
    if (this.running >= this.maxConcurrent) {
      await this.enqueue(queryId, sql, priority);
    }

    // Acquired a slot — track and run
    this.running++;
    const info: QueryInfo = { id: queryId, sql: truncateSql(sql), priority, startedAt: Date.now(), status: 'running' };
    this.activeQueries.set(queryId, info);

    try {
      const result = await this.withTimeout(fn(), queryId, timeoutMs);
      this.totalExecuted++;
      return result;
    } finally {
      this.running--;
      this.activeQueries.delete(queryId);
      this.dequeue();
    }
  }

  /**
   * Get current governor stats for monitoring.
   */
  getStats(): GovernorStats {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      timeoutMs: this.timeoutMs,
      totalExecuted: this.totalExecuted,
      totalTimedOut: this.totalTimedOut,
      totalRejected: this.totalRejected,
      activeQueries: Array.from(this.activeQueries.values()),
    };
  }

  /**
   * Reset statistics counters.
   */
  resetStats(): void {
    this.totalExecuted = 0;
    this.totalTimedOut = 0;
    this.totalRejected = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private enqueue(id: string, sql: string, priority: QueryPriority): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { id, sql, priority, resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(entry);

      // Track as queued
      this.activeQueries.set(id, {
        id,
        sql: truncateSql(sql),
        priority,
        startedAt: Date.now(),
        status: 'queued',
      });
    });
  }

  /**
   * Release the next queued entry, respecting priority lanes with
   * anti-starvation: after maxConsecutiveHighPriority high-priority
   * releases, yield to a normal-priority entry if one exists.
   */
  private dequeue(): void {
    if (this.queue.length === 0) return;

    let idx = -1;

    // Check if we need to yield to normal priority (anti-starvation)
    const shouldYieldToNormal = this.consecutiveHighPriority >= this.maxConsecutiveHighPriority;

    if (shouldYieldToNormal) {
      // Try to find a normal-priority entry first
      idx = this.queue.findIndex(e => e.priority === 'normal');
      if (idx >= 0) {
        this.consecutiveHighPriority = 0;
      }
    }

    if (idx < 0) {
      // Pick highest-priority entry (high > normal), FIFO within same priority
      const highIdx = this.queue.findIndex(e => e.priority === 'high');
      if (highIdx >= 0) {
        idx = highIdx;
        this.consecutiveHighPriority++;
      } else {
        idx = 0; // First normal-priority entry
        this.consecutiveHighPriority = 0;
      }
    }

    const entry = this.queue.splice(idx, 1)[0];
    entry.resolve();
  }

  /**
   * Wrap a promise with a timeout. On timeout, the promise is abandoned and the
   * governor slot is released so new queries can proceed.
   */
  private withTimeout<T>(promise: Promise<T>, queryId: string, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) return promise;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.totalTimedOut++;
        logger.warn(`Query governor: query ${queryId} timed out after ${timeoutMs}ms`);
        reject(new QueryGovernorError(
          `Query timed out after ${timeoutMs}ms. The query may still be running on the server.`,
          408
        ));
      }, timeoutMs);

      promise
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }
}

/**
 * Error thrown by the governor with an HTTP status code hint.
 */
export class QueryGovernorError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'QueryGovernorError';
    this.statusCode = statusCode;
  }
}

/** Max SQL length for logging/tracking. */
const SQL_TRUNCATE_LENGTH = 200;

/** Truncate SQL for logging (max SQL_TRUNCATE_LENGTH chars). */
function truncateSql(sql: string): string {
  return sql.length > SQL_TRUNCATE_LENGTH ? sql.slice(0, SQL_TRUNCATE_LENGTH) + '…' : sql;
}

// ── Singleton ──────────────────────────────────────────────────────────

let defaultGovernor: QueryGovernor | null = null;

export function getQueryGovernor(): QueryGovernor {
  if (!defaultGovernor) {
    defaultGovernor = new QueryGovernor();
    logger.info(`Query governor initialized: maxConcurrent=${config.governor.maxConcurrentQueries}, timeoutMs=${config.governor.queryTimeoutMs}, maxQueue=${config.governor.queryQueueMax}`);
  }
  return defaultGovernor;
}

export default QueryGovernor;
