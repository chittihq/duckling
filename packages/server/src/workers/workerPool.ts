import path from 'path';
import { Worker } from 'worker_threads';
import config from '../config';
import logger from '../logger';

interface PendingRequest {
  resolve: (rows: any[][]) => void;
  reject: (error: Error) => void;
  worker: Worker;
}

interface WorkerResponse {
  id: number;
  rows: any[][];
}

export class WorkerPool {
  private static instance: WorkerPool | null = null;
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();

  private constructor() {
    const workerCount = config.workers.threads;
    for (let i = 0; i < workerCount; i++) {
      this.workers.push(this.createWorker());
    }
    logger.info(`Worker pool initialized with ${this.workers.length} worker thread(s)`);
  }

  static getInstance(): WorkerPool {
    if (!WorkerPool.instance) {
      WorkerPool.instance = new WorkerPool();
    }
    return WorkerPool.instance;
  }

  async sanitizeRows(rows: any[][], columnTypes: string[]): Promise<any[][]> {
    if (!rows.length || !this.workers.length) return rows;

    const requestId = ++this.requestId;
    const worker = this.getNextWorker();

    return new Promise<any[][]>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, worker });
      worker.postMessage({ id: requestId, rows, columnTypes });
    });
  }

  private getNextWorker(): Worker {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  private createWorker(): Worker {
    const isTsRuntime = __filename.endsWith('.ts');
    const workerFile = isTsRuntime
      ? path.resolve(__dirname, 'sanitizeWorker.ts')
      : path.resolve(__dirname, 'sanitizeWorker.js');
    const worker = new Worker(workerFile, isTsRuntime ? { execArgv: ['-r', 'ts-node/register'] } : undefined);

    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      pending.resolve(message.rows);
    });

    worker.on('error', (error) => {
      logger.warn('Worker thread error, request will fall back to main thread path', error);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`Worker exited unexpectedly with code ${code}, restarting worker`);
      }

      for (const [id, pending] of this.pendingRequests.entries()) {
        if (pending.worker === worker) {
          this.pendingRequests.delete(id);
          pending.reject(new Error('Worker exited before completing sanitize request'));
        }
      }

      const index = this.workers.indexOf(worker);
      if (index >= 0) {
        this.workers[index] = this.createWorker();
      }
    });

    return worker;
  }
}

