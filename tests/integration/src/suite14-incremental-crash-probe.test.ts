import { describe, expect, test } from 'vitest';
import { apiGet } from './helpers/api.js';
import { sleep } from './helpers/cdc.js';
import { DB_ID } from './helpers/config.js';
import {
  getDucklingComposeLogs,
  getDucklingContainerState,
  getDucklingLogs,
} from './helpers/docker.js';
import { clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { startBackgroundIncrementalSync } from './helpers/sync.js';

const TABLE_NAME = 'restart_repro_rows';
const INSERT_BATCH_SIZE = 1_000;
const PROBE_INCREMENTAL_ROWS = 10_000;

async function seedRestartReproRows(rowCount: number, startId: number): Promise<void> {
  for (let i = startId; i < startId + rowCount; i += INSERT_BATCH_SIZE) {
    const end = Math.min(i + INSERT_BATCH_SIZE, startId + rowCount);
    const values: string[] = [];
    for (let j = i; j < end; j++) {
      values.push(`(${j}, 'restart-row-${j}', ${(j * 1.11).toFixed(2)}, NOW(), NOW())`);
    }
    await mysqlExec(
      `INSERT INTO ${TABLE_NAME} (id, val, num, created_at, updated_at) VALUES ${values.join(',')};`,
    );
  }
}

async function runUiLikePolls(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.allSettled([
      apiGet(`/status?db=${DB_ID}`),
      apiGet(`/health?db=${DB_ID}`),
      apiGet(`/api/tables?db=${DB_ID}`),
      apiGet(`/api/tables/counts/all?db=${DB_ID}`),
    ]);
    await sleep(250);
  }
}

async function waitForSyncWithoutCrash(
  inFlightSync: Promise<{ code: number | null; stdout: string; stderr: string }>,
  timeoutMs = 180_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let settled = false;
  let result: { code: number | null; stdout: string; stderr: string } | null = null;

  const trackedSync = inFlightSync.then((value) => {
    settled = true;
    result = value;
    return value;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getDucklingContainerState();
    if (!state.running) {
      const composeLogs = getDucklingComposeLogs(1200);
      throw new Error(
        `Duckling exited during incremental sync (status=${state.status}, exitCode=${state.exitCode}, raw=${state.raw})\n\n${composeLogs}`,
      );
    }

    if (settled && result) {
      return result;
    }

    await sleep(250);
  }

  await trackedSync;
  if (result) {
    return result;
  }
  throw new Error(`Timed out waiting for incremental sync to finish within ${timeoutMs}ms`);
}

describe('Suite 14: Incremental Crash Probe', () => {
  test('default persisted-volume incremental probe does not exit with a segfault', async () => {
    const currentCount = Number(await clickhouseScalarStrict(`SELECT COUNT(*) AS cnt FROM ${TABLE_NAME}`, 'cnt'));
    const nextId = currentCount + 1;
    const expectedFinalCount = currentCount + PROBE_INCREMENTAL_ROWS;

    await seedRestartReproRows(PROBE_INCREMENTAL_ROWS, nextId);

    const inFlightSync = startBackgroundIncrementalSync();
    const uiPolls = runUiLikePolls();
    const syncResult = await waitForSyncWithoutCrash(inFlightSync);
    await uiPolls;

    const finalCount = Number(await clickhouseScalarStrict(`SELECT COUNT(*) AS cnt FROM ${TABLE_NAME}`, 'cnt'));
    const state = getDucklingContainerState();
    const syncLogs = getDucklingLogs(1600);
    const composeLogs = getDucklingComposeLogs(1200);

    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe('');
    expect(finalCount).toBe(expectedFinalCount);
    expect(state.running).toBe(true);
    expect(state.exitCode ?? 0).not.toBe(139);
    expect(syncLogs).toContain(`Watermark incremental sync completed for ${TABLE_NAME}:`);
    expect(composeLogs).not.toContain('Segmentation fault');
  }, 240_000);
});
