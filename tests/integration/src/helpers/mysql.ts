import { execSync } from 'child_process';
import { apiPost } from './api.js';
import { DB_ID, INTEGRATION_DIR } from './config.js';

export async function mysqlQuery(sql: string): Promise<any> {
  return apiPost(`/api/query?db=${DB_ID}`, { sql, database: 'mysql' });
}

export async function mysqlScalar(sql: string, field: string): Promise<string> {
  const data = await mysqlQuery(sql);
  const row = data?.result?.[0];
  if (!row) return 'null';
  const val = row[field];
  if (val === null || val === undefined) return 'null';
  return String(val);
}

export function mysqlExec(sql: string): void {
  execSync(
    'docker compose exec -T mysql mysql -h 127.0.0.1 -uintegration -pintegrationpass --default-character-set=utf8mb4 integration_db',
    { input: sql, cwd: INTEGRATION_DIR, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
