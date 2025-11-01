/**
 * Table column definition
 */
export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
}

/**
 * Table schema information
 */
export interface TableSchema {
  tableName: string;
  columns: TableColumn[];
  rowCount?: number;
}

/**
 * Table metadata
 */
export interface TableMetadata {
  name: string;
  rowCount: number;
  lastSync?: string;
  syncType?: string;
}

/**
 * Table data response with pagination
 */
export interface TableDataResponse {
  tableName: string;
  data: any[];
  total: number;
  limit: number;
  offset: number;
}
