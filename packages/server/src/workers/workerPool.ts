/**
 * Worker Pool
 *
 * Manages a pool of worker_threads for CPU-heavy row sanitization.
 * Dispatches batches round-robin across workers and handles worker crashes
 * with automatic respawn.
 *
 * Usage:
 *   const pool = WorkerPool.getInstance();
 *   const sanitized = await pool.sanitizeBatch(rows, columns, columnTypes);
 *
 * Environment:
 *   WORKER_THREADS — Number of worker threads.
 *                    0 or unset = disabled (default). Positive integer = that many threads.
 *
 * NOTE: Worker threads are disabled by default because @duckdb/node-api's
 * native addon can segfault (SIGSEGV / exit code 139) when Node.js
 * worker_threads exist in the same process. When disabled, callers fall
 * back to main-thread sanitization via their existing try/catch paths.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import config from '../config';
import logger from '../logger';

interface PendingRequest {
  resolve: (rows: any[][]) => void;
  reject: (error: Error) => void;
  sentAt: number;
  worker: Worker;
}

export interface WorkerPoolStats {
  poolSize: number;
  activeWorkers: number;
  pendingRequests: number;
  totalProcessed: number;
  totalErrors: number;
  totalRespawns: number;
  disabled: boolean;
}

export class WorkerPool {
  private static instance: WorkerPool | null = null;
  private workers: Worker[] = [];
  private pending: Map<number, PendingRequest> = new Map();
  private nextWorker: number = 0;
  private requestId: number = 0;
  private poolSize: number;
  private disabled: boolean;
  private workerScript: string = '';
  private workerExecArgv?: string[];

  // Stats
  private totalProcessed: number = 0;
  private totalErrors: number = 0;
  private totalRespawns: number = 0;

  private constructor() {
    const configured = config.workers.threads;
    this.disabled = configured <= 0;

    if (this.disabled) {
      this.poolSize = 0;
      logger.info('Worker pool disabled (WORKER_THREADS=0). Sanitization will run on main thread.');
      return;
    }

    this.poolSize = configured;

    // Resolve worker script path: prefer compiled .js, fall back to .ts (dev mode with ts-node)
    const jsPath = path.resolve(__dirname, '../workers/sanitizeWorker.js');
    const tsPath = path.resolve(__dirname, '../workers/sanitizeWorker.ts');

    if (fs.existsSync(jsPath)) {
      this.workerScript = jsPath;
      this.workerExecArgv = undefined;
    } else if (fs.existsSync(tsPath)) {
      this.workerScript = tsPath;
      this.workerExecArgv = ['-r', 'ts-node/register'];
    } else {
      throw new Error(`sanitize worker script not found: checked ${jsPath} and ${tsPath}`);
    }

    this.spawnAll();
    logger.info(`Worker pool initialized: ${this.poolSize} threads, script=${this.workerScript}`);
  }

  static getInstance(): WorkerPool {
    if (!WorkerPool.instance) {
      WorkerPool.instance = new WorkerPool();
    }
    return WorkerPool.instance;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Shut down all workers gracefully.
   */
  async shutdown(): Promise<void> {
    const terminations = this.workers.map(w => w.terminate());
    await Promise.all(terminations);
    this.workers = [];
    WorkerPool.instance = null;
    logger.info('Worker pool shut down');
  }

  /**
   * Sanitize a batch of rows using a worker thread.
   *
   * @param rows     Raw row objects from MySQL
   * @param columns  Column names in order
   * @param columnTypes  Map of column name → MySQL type string
   * @returns Sanitized rows as column-ordered arrays (ready for DuckDB append)
   */
  sanitizeBatch(
    rows: Record<string, any>[],
    columns: string[],
    columnTypes: Record<string, string>
  ): Promise<any[][]> {
    if (this.disabled) {
      return Promise.reject(new Error('Worker pool is disabled'));
    }

    if (!rows.length) {
      return Promise.resolve([]);
    }

    if (!this.workers.length) {
      return Promise.reject(new Error('Worker pool is unavailable'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const worker = this.workers[this.nextWorker % this.poolSize];
      this.nextWorker = (this.nextWorker + 1) % this.poolSize;

      this.pending.set(id, { resolve, reject, sentAt: Date.now(), worker });

      worker.postMessage({ id, rows, columns, columnTypes });
    });
  }

  /**
   * Get pool statistics for monitoring.
   */
  getStats(): WorkerPoolStats {
    return {
      poolSize: this.poolSize,
      activeWorkers: this.workers.length,
      pendingRequests: this.pending.size,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      totalRespawns: this.totalRespawns,
      disabled: this.disabled,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private spawnAll(): void {
    for (let i = 0; i < this.poolSize; i++) {
      this.spawnWorker(i);
    }
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(
      this.workerScript,
      this.workerExecArgv ? { execArgv: this.workerExecArgv } : undefined
    );

    worker.on('message', (msg: { id: number; rows?: any[][]; error?: string }) => {
      const req = this.pending.get(msg.id);
      if (!req) return;

      this.pending.delete(msg.id);

      if (msg.error) {
        this.totalErrors++;
        req.reject(new Error(`Worker sanitization failed: ${msg.error}`));
      } else {
        this.totalProcessed++;
        req.resolve(msg.rows!);
      }
    });

    worker.on('error', (err) => {
      logger.warn(`Worker ${index} error, request(s) will fall back to main-thread sanitization:`, err);
      this.totalErrors++;
      this.rejectPendingRequestsForWorker(
        worker,
        new Error(`Worker ${index} error: ${err.message}`)
      );
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`Worker ${index} exited with code ${code}, rejecting in-flight requests for this worker and respawning`);
        this.totalRespawns++;

        this.rejectPendingRequestsForWorker(
          worker,
          new Error(`Worker ${index} exited unexpectedly with code ${code}`)
        );

        this.spawnWorker(index);
      }
    });

    this.workers[index] = worker;
  }

  private rejectPendingRequestsForWorker(worker: Worker, error: Error): void {
    for (const [id, req] of this.pending.entries()) {
      if (req.worker === worker) {
        this.totalErrors++;
        req.reject(error);
        this.pending.delete(id);
      }
    }
  }
}

export default WorkerPool;
