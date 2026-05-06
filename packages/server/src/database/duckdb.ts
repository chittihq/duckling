/**
 * Legacy DuckDB connection removed during the ClickHouse migration.
 * Kept as a compatibility stub for any remaining out-of-path imports.
 */
class DuckDBConnection {
  static getInstance(): never {
    throw new Error('DuckDBConnection was removed during the ClickHouse migration');
  }

  static closeInstance(): void {}
}

export function sanitizeLogParams(params?: any[]): any[] | undefined {
  return params;
}

export default DuckDBConnection;
