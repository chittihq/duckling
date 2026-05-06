export class SyncAlreadyInProgressError extends Error {
  constructor(message = 'Another sync operation is already in progress. Please wait for it to complete.') {
    super(message);
    this.name = 'SyncAlreadyInProgressError';
  }
}

export interface SyncResult {
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

export interface SyncStats {
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
