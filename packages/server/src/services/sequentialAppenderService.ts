export class SyncAlreadyInProgressError extends Error {
  constructor(message = 'Another sync operation is already in progress. Please wait for it to complete.') {
    super(message);
    this.name = 'SyncAlreadyInProgressError';
  }
}

export interface AppenderSyncResult {
  table: string;
  recordsProcessed: number;
  duration: number;
  status: 'success' | 'error';
  error?: string;
  syncType: 'sequential' | 'watermark';
  watermark?: {
    lastProcessedId?: string | number;
    lastProcessedTimestamp?: Date;
    primaryKey?: string;
  };
}

export interface AppenderSyncStats {
  totalTables: number;
  successfulTables: number;
  failedTables: number;
  totalRecords: number;
  totalDuration: number;
  errors: string[];
  syncDetails: {
    sequential: number;
    watermark: number;
  };
}

export interface SyncProgressStatus {
  inProgress: boolean;
  type: 'full' | 'incremental' | null;
  tablesCompleted: number;
  tablesTotal: number;
  currentTable: string | null;
  recordsProcessed: number;
  startedAt: string | null;
  lastError: string | null;
}

/**
 * Legacy DuckDB sync service removed during the ClickHouse migration.
 * Kept as a compatibility stub for imports that only need shared types.
 */
class SequentialAppenderService {
  static getInstance(): never {
    throw new Error('SequentialAppenderService was removed during the ClickHouse migration');
  }
}

export default SequentialAppenderService;
