import config from '../config';

export type QueryPriority = 'high' | 'normal';

export interface QueryGovernorOptions {
  priority?: QueryPriority;
  timeoutMs?: number;
}

interface PendingTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutMs: number;
  priority: QueryPriority;
}

export class QueryQueueFullError extends Error {
  constructor() {
    super('Query queue is full');
    this.name = 'QueryQueueFullError';
  }
}

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Query timed out after ${timeoutMs}ms`);
    this.name = 'QueryTimeoutError';
  }
}

export class QueryGovernor {
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly queueMax: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxConsecutiveHigh: number;
  private readonly highPriorityQueue: PendingTask<any>[] = [];
  private readonly normalPriorityQueue: PendingTask<any>[] = [];
  private consecutiveHighServed = 0;

  constructor(overrides: {
    maxConcurrentQueries?: number;
    queueMax?: number;
    timeoutMs?: number;
    maxConsecutiveHighPriority?: number;
  } = {}) {
    this.maxConcurrent = overrides.maxConcurrentQueries ?? config.queryGovernor.maxConcurrentQueries;
    this.queueMax = overrides.queueMax ?? config.queryGovernor.queueMax;
    this.defaultTimeoutMs = overrides.timeoutMs ?? config.queryGovernor.timeoutMs;
    this.maxConsecutiveHigh = overrides.maxConsecutiveHighPriority ?? config.queryGovernor.maxConsecutiveHighPriority;
  }

  async execute<T>(run: () => Promise<T>, options: QueryGovernorOptions = {}): Promise<T> {
    const priority = options.priority || 'normal';
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    if (this.activeCount < this.maxConcurrent) {
      return this.runTask(run, timeoutMs);
    }

    if (this.queuedCount() >= this.queueMax) {
      throw new QueryQueueFullError();
    }

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask<T> = { run, resolve, reject, timeoutMs, priority };
      if (priority === 'high') {
        this.highPriorityQueue.push(task);
      } else {
        this.normalPriorityQueue.push(task);
      }
    });
  }

  getStats(): { active: number; queued: number; queuedHigh: number; queuedNormal: number } {
    return {
      active: this.activeCount,
      queued: this.queuedCount(),
      queuedHigh: this.highPriorityQueue.length,
      queuedNormal: this.normalPriorityQueue.length
    };
  }

  private queuedCount(): number {
    return this.highPriorityQueue.length + this.normalPriorityQueue.length;
  }

  private dequeueNext(): PendingTask<any> | null {
    if (!this.highPriorityQueue.length && !this.normalPriorityQueue.length) {
      return null;
    }

    if (!this.normalPriorityQueue.length) {
      this.consecutiveHighServed++;
      return this.highPriorityQueue.shift() || null;
    }

    if (!this.highPriorityQueue.length) {
      this.consecutiveHighServed = 0;
      return this.normalPriorityQueue.shift() || null;
    }

    if (this.consecutiveHighServed >= this.maxConsecutiveHigh) {
      this.consecutiveHighServed = 0;
      return this.normalPriorityQueue.shift() || null;
    }

    this.consecutiveHighServed++;
    return this.highPriorityQueue.shift() || null;
  }

  private async runTask<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
    this.activeCount++;

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const result = run();
      // NOTE: @duckdb/node-api does not currently expose hard query cancellation here.
      // Timeout therefore bounds API wait time and queue pressure; underlying work may finish shortly after.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new QueryTimeoutError(timeoutMs));
        }, timeoutMs);
      });
      return await Promise.race([result, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.activeCount--;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    while (this.activeCount < this.maxConcurrent) {
      const task = this.dequeueNext();
      if (!task) return;

      this.runTask(task.run, task.timeoutMs)
        .then(task.resolve)
        .catch(task.reject);
    }
  }
}
