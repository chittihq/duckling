/**
 * Database health status
 */
export interface DatabaseHealth {
  connected: boolean;
  latency?: number;
  error?: string;
}

/**
 * System health response
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  clickhouse?: DatabaseHealth;
  mysql: DatabaseHealth;
  architecture: 'clickhouse';
  version?: string;
}

/**
 * System status with detailed metrics
 */
export interface StatusResponse {
  status: 'running' | 'stopped' | 'error';
  uptime: number;
  tableCount: number;
  totalRecords: number;
  clickhouseConnected?: boolean;
  mysqlConnected: boolean;
  lastSync?: Date;
  architecture: 'clickhouse';
  version?: string;
}
