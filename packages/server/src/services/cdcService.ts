import logger from '../logger';

interface BinlogPosition {
  filename: string;
  position: number;
  timestamp: Date;
}

interface CDCConfig {
  databaseId: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlDatabase: string;
  includeTables?: string[];
  excludeTables?: string[];
}

interface CDCStats {
  isRunning: boolean;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  eventsProcessed: number;
  insertsProcessed: number;
  updatesProcessed: number;
  deletesProcessed: number;
  errors: number;
  currentPosition: BinlogPosition | null;
  queueSize: number;
  queueHighWaterMark: number;
  message?: string;
}

/**
 * CDC is not ported to ClickHouse yet.
 * This stub preserves the public interface so the rest of the server
 * can fail explicitly instead of depending on DuckDB-only logic.
 */
export class CDCService {
  private static instances: Map<string, CDCService> = new Map();

  private readonly databaseId: string;
  private readonly config: CDCConfig;
  private readonly stats: CDCStats;

  private constructor(config: CDCConfig) {
    this.databaseId = config.databaseId;
    this.config = config;
    this.stats = {
      isRunning: false,
      connectedAt: null,
      lastEventAt: null,
      eventsProcessed: 0,
      insertsProcessed: 0,
      updatesProcessed: 0,
      deletesProcessed: 0,
      errors: 0,
      currentPosition: null,
      queueSize: 0,
      queueHighWaterMark: 0,
      message: 'CDC is not implemented for the ClickHouse migration yet',
    };
  }

  static getInstance(databaseId: string): CDCService | null {
    return CDCService.instances.get(databaseId) || null;
  }

  static async createInstance(config: CDCConfig): Promise<CDCService> {
    const instance = new CDCService(config);
    CDCService.instances.set(config.databaseId, instance);
    return instance;
  }

  static parseConnectionString(connectionString: string, databaseId: string): CDCConfig {
    const url = new URL(connectionString);
    return {
      databaseId,
      mysqlHost: url.hostname,
      mysqlPort: parseInt(url.port) || 3306,
      mysqlUser: url.username,
      mysqlPassword: url.password,
      mysqlDatabase: url.pathname.replace('/', '').split('?')[0],
    };
  }

  static async stopAll(): Promise<void> {
    for (const instance of CDCService.instances.values()) {
      await instance.stop();
    }
    CDCService.instances.clear();
  }

  static getAllInstances(): Map<string, CDCService> {
    return CDCService.instances;
  }

  async start(): Promise<void> {
    logger.warn(`CDC start requested for ${this.databaseId}, but CDC is not implemented for ClickHouse`);
    throw new Error('CDC is not implemented for the ClickHouse migration yet');
  }

  async stop(): Promise<void> {
    this.stats.isRunning = false;
  }

  getStats(): CDCStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.eventsProcessed = 0;
    this.stats.insertsProcessed = 0;
    this.stats.updatesProcessed = 0;
    this.stats.deletesProcessed = 0;
    this.stats.errors = 0;
    this.stats.queueSize = 0;
    this.stats.queueHighWaterMark = 0;
  }
}

export default CDCService;
