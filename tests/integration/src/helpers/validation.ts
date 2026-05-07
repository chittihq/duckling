import { apiPost } from './api.js';
import { DB_ID } from './config.js';

export async function getValidation(table: string): Promise<any> {
  const response = await apiPost(`/api/validation/table-details?db=${DB_ID}`, { tableName: table });
  if (response.clickhouse && !response.duckdb) {
    response.duckdb = response.clickhouse;
  }
  return response;
}
