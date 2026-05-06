export interface ReplicaStatus {
  enabled: boolean;
  databaseId: string;
  primaryPath: string;
  replicaPath: string;
  lastRefreshedAt: Date | null;
  refreshIntervalSeconds: number;
  isRefreshing: boolean;
  totalRefreshes: number;
  totalErrors: number;
}

/**
 * Legacy DuckDB read-replica service removed during the ClickHouse migration.
 */
export class ReadReplicaService {
  static getInstance(): ReadReplicaService {
    return new ReadReplicaService();
  }

  getStatus(): ReplicaStatus {
    return {
      enabled: false,
      databaseId: 'unavailable',
      primaryPath: '',
      replicaPath: '',
      lastRefreshedAt: null,
      refreshIntervalSeconds: 0,
      isRefreshing: false,
      totalRefreshes: 0,
      totalErrors: 0,
    };
  }
}

export default ReadReplicaService;
