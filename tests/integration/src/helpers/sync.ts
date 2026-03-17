import { spawn } from 'child_process';
import { API_KEY, API_URL, DB_ID } from './config.js';
import { apiPost } from './api.js';

export async function triggerFullSync(): Promise<any> {
  return apiPost(`/sync/full?db=${DB_ID}`);
}

export async function triggerIncrementalSync(): Promise<any> {
  return apiPost(`/sync/incremental?db=${DB_ID}`);
}

export async function triggerTableSync(table: string): Promise<any> {
  return apiPost(`/sync/table/${encodeURIComponent(table)}?db=${DB_ID}`);
}

export function startBackgroundIncrementalSync(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const url = `${API_URL}/sync/incremental?db=${DB_ID}`;
  const child = spawn(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      url,
      '-H',
      `Authorization: ${API_KEY}`,
      '-H',
      'Content-Type: application/json',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      stderr += String(error);
      resolve({ code: -1, stdout, stderr });
    });
  });
}
