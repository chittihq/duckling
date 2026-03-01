import { apiPost } from './api.js';
import { DB_ID } from './config.js';

export async function triggerFullSync(): Promise<any> {
  return apiPost(`/sync/full?db=${DB_ID}`);
}

export async function triggerIncrementalSync(): Promise<any> {
  return apiPost(`/sync/incremental?db=${DB_ID}`);
}

export async function triggerTableSync(table: string): Promise<any> {
  return apiPost(`/sync/table/${encodeURIComponent(table)}?db=${DB_ID}`);
}
