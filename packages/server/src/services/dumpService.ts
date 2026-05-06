export interface DumpResult {
  success: boolean;
  dumpFile?: string;
  totalTables: number;
  totalRecords: number;
  duration: number;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  totalTables: number;
  totalRecords: number;
  duration: number;
  error?: string;
}

/**
 * Legacy DuckDB dump tooling removed during the ClickHouse migration.
 */
class DumpService {
  static getInstance(): DumpService {
    return new DumpService();
  }

  async createFullDump(): Promise<DumpResult> {
    return {
      success: false,
      totalTables: 0,
      totalRecords: 0,
      duration: 0,
      error: 'DuckDB dump tooling was removed during the ClickHouse migration',
    };
  }

  async restoreFromDump(): Promise<RestoreResult> {
    return {
      success: false,
      totalTables: 0,
      totalRecords: 0,
      duration: 0,
      error: 'DuckDB restore tooling was removed during the ClickHouse migration',
    };
  }

  async listDumps(): Promise<string[]> {
    return [];
  }

  async cleanupOldDumps(): Promise<number> {
    return 0;
  }
}

export function mapMySQLTypeToDuckDB(_mysqlType: string): string {
  throw new Error('DuckDB type mapping was removed during the ClickHouse migration');
}

export default DumpService;
