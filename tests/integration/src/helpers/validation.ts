import { apiPost } from './api.js';
import { DB_ID } from './config.js';

export async function getValidation(table: string): Promise<any> {
  return apiPost(`/api/validation/table-details?db=${DB_ID}`, { tableName: table });
}
