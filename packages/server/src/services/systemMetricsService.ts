import * as os from 'os';
import logger from '../logger';

interface SystemSample {
  ts: string;
  cpuPercent: number;
  rssMB: number;
  eventLoopLagMs: number;
}

const BUFFER_SIZE = 61; // 30.5 minutes at 30s intervals
const SAMPLE_INTERVAL_MS = 30_000;

class SystemMetricsService {
  private static instance: SystemMetricsService;
  private history: SystemSample[] = [];
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastSampleTime: number = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): SystemMetricsService {
    if (!SystemMetricsService.instance) {
      SystemMetricsService.instance = new SystemMetricsService();
    }
    return SystemMetricsService.instance;
  }

  start(): void {
    if (this.intervalHandle) return;
    // Take an initial baseline
    this.lastCpuUsage = process.cpuUsage();
    this.lastSampleTime = Date.now();
    // First real sample after one interval
    this.intervalHandle = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    logger.info('SystemMetricsService started (sampling every 30s)');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private sample(): void {
    try {
      const now = Date.now();
      const cpuDelta = process.cpuUsage(this.lastCpuUsage!);
      const elapsedMs = now - this.lastSampleTime;

      // CPU % for this Node process (user + system microseconds → ms, relative to wall clock)
      const cpuPercent = elapsedMs > 0
        ? parseFloat((((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100).toFixed(1))
        : 0;

      const mem = process.memoryUsage();
      const rssMB = parseFloat((mem.rss / 1024 / 1024).toFixed(1));

      // Event loop lag: measure how late a setImmediate fires compared to a high-res timer
      const lagStart = Date.now();
      setImmediate(() => {
        const eventLoopLagMs = Date.now() - lagStart;

        const sample: SystemSample = {
          ts: new Date(now).toISOString(),
          cpuPercent,
          rssMB,
          eventLoopLagMs,
        };

        this.history.push(sample);
        if (this.history.length > BUFFER_SIZE) {
          this.history.shift();
        }
      });

      this.lastCpuUsage = process.cpuUsage();
      this.lastSampleTime = now;
    } catch (err) {
      logger.warn('SystemMetricsService sample error:', err);
    }
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    const lastSample = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    return {
      current: {
        cpuPercent: lastSample?.cpuPercent ?? 0,
        rssMB: parseFloat((mem.rss / 1024 / 1024).toFixed(1)),
        heapUsedMB: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(1)),
        hostFreeMemMB: parseFloat((os.freemem() / 1024 / 1024).toFixed(1)),
        hostTotalMemMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
        eventLoopLagMs: lastSample?.eventLoopLagMs ?? 0,
      },
      history: [...this.history],
    };
  }
}

export default SystemMetricsService;
