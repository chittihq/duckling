/**
 * Sync operation types
 */
export type SyncType = 'full' | 'incremental' | 'watermark' | 'sequential';

/**
 * Sync status
 */
export type SyncStatus = 'success' | 'error' | 'in_progress';

/**
 * Watermark tracking for incremental sync
 */
export interface Watermark {
  tableName: string;
  lastProcessedId?: number | string;
  lastProcessedTimestamp?: string;
  updatedAt: string;
}

/**
 * Sync log entry
 */
export interface SyncLog {
  id?: number;
  tableName: string;
  syncType: SyncType;
  recordsProcessed: number;
  durationMs: number;
  status: SyncStatus;
  errorMessage?: string;
  watermarkBefore?: string; // JSON stringified watermark
  watermarkAfter?: string;  // JSON stringified watermark
  createdAt: string;
}

/**
 * Sync status response
 */
export interface SyncStatusResponse {
  isRunning: boolean;
  lastSync?: Date;
  tablesProcessed?: number;
  totalRecords?: number;
  successCount?: number;
  errorCount?: number;
  watermarks?: Watermark[];
  recentLogs?: SyncLog[];
  architecture: 'clickhouse';
}
