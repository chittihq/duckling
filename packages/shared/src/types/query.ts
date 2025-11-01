/**
 * Query request payload
 */
export interface QueryRequest {
  sql: string;
  params?: any[];
}

/**
 * Query response with results
 */
export interface QueryResponse {
  data: any[];
  rowCount: number;
  duration?: number;
}

/**
 * Query error response
 */
export interface QueryError {
  error: string;
  message: string;
  sql?: string;
}
