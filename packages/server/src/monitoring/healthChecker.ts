export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  error?: string;
  lastCheck: string;
}

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    mysql: ServiceHealth;
    clickhouse: ServiceHealth;
    sync: ServiceHealth;
  };
  metrics: {
    uptime: number;
    memory: NodeJS.MemoryUsage;
    lastSync: Date | null;
    errorRate: number;
  };
}

/**
 * Legacy dedicated health checker removed during the ClickHouse migration.
 */
class HealthChecker {
  static getInstance(): HealthChecker {
    return new HealthChecker();
  }

  async checkHealth(): Promise<HealthStatus> {
    return {
      overall: 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        mysql: { status: 'degraded', error: 'Legacy health checker removed', lastCheck: new Date().toISOString() },
        clickhouse: { status: 'degraded', error: 'Legacy health checker removed', lastCheck: new Date().toISOString() },
        sync: { status: 'degraded', error: 'Legacy health checker removed', lastCheck: new Date().toISOString() },
      },
      metrics: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        lastSync: null,
        errorRate: 1,
      },
    };
  }
}

export default HealthChecker;
