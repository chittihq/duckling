import MySQLConnection from '../database/mysql';
import DuckDBConnection from '../database/duckdb';
import SequentialAppenderService from '../services/sequentialAppenderService';
import logger from '../logger';
import config from '../config';

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    mysql: ServiceHealth;
    duckdb: ServiceHealth;
    sync: ServiceHealth;
  };
  metrics: {
    uptime: number;
    memory: NodeJS.MemoryUsage;
    lastSync: Date | null;
    errorRate: number;
  };
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  error?: string;
  lastCheck: string;
}

class HealthChecker {
  private mysql: MySQLConnection;
  private duckdb: DuckDBConnection;
  private syncService: SequentialAppenderService;
  private static instance: HealthChecker;

  private constructor() {
    this.mysql = MySQLConnection.getInstance();
    this.duckdb = DuckDBConnection.getInstance();
    this.syncService = SequentialAppenderService.getInstance();
  }

  static getInstance(): HealthChecker {
    if (!HealthChecker.instance) {
      HealthChecker.instance = new HealthChecker();
    }
    return HealthChecker.instance;
  }

  async checkHealth(): Promise<HealthStatus> {
    const startTime = Date.now();
    
    try {
      const [mysqlHealth, duckdbHealth, syncHealth] = await Promise.all([
        this.checkMySQLHealth(),
        this.checkDuckDBHealth(),
        this.checkSyncHealth()
      ]);

      const errorRate = await this.calculateErrorRate();
      const lastSync = await this.getLastSyncTime();
      
      const overallStatus = this.determineOverallStatus([mysqlHealth, duckdbHealth, syncHealth]);
      
      return {
        overall: overallStatus,
        timestamp: new Date().toISOString(),
        services: {
          mysql: mysqlHealth,
          duckdb: duckdbHealth,
          sync: syncHealth
        },
        metrics: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          lastSync,
          errorRate
        }
      };
    } catch (error) {
      logger.error('Health check failed:', error);
      return {
        overall: 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          mysql: { status: 'unhealthy', error: 'Health check failed', lastCheck: new Date().toISOString() },
          duckdb: { status: 'unhealthy', error: 'Health check failed', lastCheck: new Date().toISOString() },
          sync: { status: 'unhealthy', error: 'Health check failed', lastCheck: new Date().toISOString() }
        },
        metrics: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          lastSync: null,
          errorRate: 1.0
        }
      };
    }
  }

  private async checkMySQLHealth(): Promise<ServiceHealth> {
    const startTime = Date.now();
    
    try {
      const isConnected = await this.mysql.testConnection();
      const latency = Date.now() - startTime;
      
      if (!isConnected) {
        return {
          status: 'unhealthy',
          latency,
          error: 'Connection failed',
          lastCheck: new Date().toISOString()
        };
      }
      
      const status = latency > 5000 ? 'degraded' : 'healthy';
      
      return {
        status,
        latency,
        lastCheck: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        lastCheck: new Date().toISOString()
      };
    }
  }

  private async checkDuckDBHealth(): Promise<ServiceHealth> {
    const startTime = Date.now();
    
    try {
      const isConnected = await this.duckdb.testConnection();
      const latency = Date.now() - startTime;
      
      if (!isConnected) {
        return {
          status: 'unhealthy',
          latency,
          error: 'Connection failed',
          lastCheck: new Date().toISOString()
        };
      }
      
      const status = latency > 2000 ? 'degraded' : 'healthy';
      
      return {
        status,
        latency,
        lastCheck: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        lastCheck: new Date().toISOString()
      };
    }
  }

  private async checkSyncHealth(): Promise<ServiceHealth> {
    try {
      const status = await this.syncService.getSyncStatus();
      
      const recentFailures = status.recentLogs.filter(
        (log: any) => log.status === 'error' && 
        Date.now() - new Date(log.created_at).getTime() < 3600000
      );
      
      const lastHourLogs = status.recentLogs.filter(
        (log: any) => Date.now() - new Date(log.created_at).getTime() < 3600000
      );
      
      const errorRate = lastHourLogs.length > 0 ? recentFailures.length / lastHourLogs.length : 0;
      
      let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      
      if (errorRate > 0.5) {
        healthStatus = 'unhealthy';
      } else if (errorRate > 0.2) {
        healthStatus = 'degraded';
      }
      
      return {
        status: healthStatus,
        error: recentFailures.length > 0 ? `${recentFailures.length} recent failures` : undefined,
        lastCheck: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        lastCheck: new Date().toISOString()
      };
    }
  }

  private async calculateErrorRate(): Promise<number> {
    try {
      const logs = await this.duckdb.execute(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
        FROM sync_log
        WHERE created_at > datetime('now', '-1 hour')
      `);

      const { total, errors } = logs[0] || { total: 0, errors: 0 };
      return total > 0 ? errors / total : 0;
    } catch (error) {
      logger.error('Failed to calculate error rate:', error);
      return 0;
    }
  }

  private async getLastSyncTime(): Promise<Date | null> {
    try {
      const result = await this.duckdb.execute(`
        SELECT MAX(created_at) as last_sync
        FROM sync_log
        WHERE status = 'success'
      `);
      
      return result[0]?.last_sync ? new Date(result[0].last_sync) : null;
    } catch (error) {
      logger.error('Failed to get last sync time:', error);
      return null;
    }
  }

  private determineOverallStatus(services: ServiceHealth[]): 'healthy' | 'degraded' | 'unhealthy' {
    const statuses = services.map(s => s.status);
    
    if (statuses.includes('unhealthy')) {
      return 'unhealthy';
    }
    
    if (statuses.includes('degraded')) {
      return 'degraded';
    }
    
    return 'healthy';
  }

  async startPeriodicHealthChecks(): Promise<void> {
    setInterval(async () => {
      try {
        const health = await this.checkHealth();
        
        if (health.overall === 'unhealthy') {
          logger.error('System is unhealthy:', health);
        } else if (health.overall === 'degraded') {
          logger.warn('System is degraded:', health);
        }
      } catch (error) {
        logger.error('Periodic health check failed:', error);
      }
    }, config.monitoring.healthCheckInterval);
    
    logger.info('Started periodic health checks');
  }
}

export default HealthChecker;