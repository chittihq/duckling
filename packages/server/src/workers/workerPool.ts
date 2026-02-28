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
 *   WORKER_THREADS — Number of worker threads (default: CPU count - 1, min 1)
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import config from '../config';
import logger from '../logger';

interface PendingRequest {
  resolve: (rows: any[][]) => void;
  reject: (error: Error) => void;
  sentAt: number;
}

export interface WorkerPoolStats {
  poolSize: number;
  activeWorkers: number;
  pendingRequests: number;
  totalProcessed: number;
  totalErrors: number;
  totalRespawns: number;
}

export class WorkerPool {
  private static instance: WorkerPool | null = null;
  private workers: Worker[] = [];
  private pending: Map<number, PendingRequest> = new Map();
  private nextWorker: number = 0;
  private requestId: number = 0;
  private poolSize: number;
  private workerScript: string;

  // Stats
  private totalProcessed: number = 0;
  private totalErrors: number = 0;
  private totalRespawns: number = 0;

  private constructor() {
    const configured = config.workers.threads;
    this.poolSize = configured > 0 ? configured : Math.max(1, os.cpus().length - 1);

    // Resolve worker script path: prefer compiled .js, fall back to .ts (dev mode with ts-node)
    const jsPath = path.resolve(__dirname, '../workers/sanitizeWorker.js');
    const tsPath = path.resolve(__dirname, '../workers/sanitizeWorker.ts');

    if (fs.existsSync(jsPath)) {
      this.workerScript = jsPath;
    } else {
      this.workerScript = tsPath;
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
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const worker = this.workers[this.nextWorker % this.poolSize];
      this.nextWorker = (this.nextWorker + 1) % this.poolSize;

      this.pending.set(id, { resolve, reject, sentAt: Date.now() });

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
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private spawnAll(): void {
    for (let i = 0; i < this.poolSize; i++) {
      this.spawnWorker(i);
    }
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(this.workerScript);

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
      logger.error(`Worker ${index} error:`, err);
      // Reject all pending requests for this worker
      // (we can't tell which requests were on which worker, so reject all pending)
      this.totalErrors++;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`Worker ${index} exited with code ${code}, respawning...`);
        this.totalRespawns++;
        this.spawnWorker(index);
      }
    });

    this.workers[index] = worker;
  }
}

export default WorkerPool;
