import { spawn } from 'child_process';
import { API_KEY, API_URL, DB_ID } from './config.js';
import { apiGet, apiPost } from './api.js';

export async function triggerFullSync(): Promise<any> {
  return apiPost(`/sync/full?db=${DB_ID}`);
}

export async function triggerIncrementalSync(): Promise<any> {
  return apiPost(`/sync/incremental?db=${DB_ID}`);
}

export async function triggerTableSync(table: string): Promise<any> {
  return apiPost(`/sync/table/${encodeURIComponent(table)}?db=${DB_ID}`);
}

/**
 * Barrier: wait until no sync is running for this database. POST /sync/full
 * kicks a sync that keeps rebuilding tables (drop raw+view -> recreate ->
 * stream) after the HTTP response returns; a suite that triggers one and
 * exits bleeds those rebuild windows into the next suite, whose reads then
 * hit "Unknown table" 500s. Call this before a suite hands over.
 * Requires `stableChecks` consecutive idle polls to dodge inter-table gaps.
 */
export async function waitForSyncIdle(timeoutMs = 120_000, stableChecks = 3): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveIdle = 0;
  while (Date.now() < deadline) {
    let inProgress = true;
    try {
      const progress = await apiGet(`/sync/progress?db=${DB_ID}`);
      inProgress = progress?.inProgress === true;
    } catch {
      // transient API error: treat as busy and keep polling
    }
    consecutiveIdle = inProgress ? 0 : consecutiveIdle + 1;
    if (consecutiveIdle >= stableChecks) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
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
