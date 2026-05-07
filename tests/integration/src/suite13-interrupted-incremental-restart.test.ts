import { beforeAll, describe, expect, test } from 'vitest';
import { startBackgroundIncrementalSync, triggerFullSync, triggerIncrementalSync } from './helpers/sync.js';
import { clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { sleep } from './helpers/cdc.js';
import {
  getDucklingComposeLogs,
  getDucklingContainerState,
  getDucklingLogs,
  killDucklingHard,
  startDuckling,
  waitForDucklingLog,
  waitForDucklingReady,
} from './helpers/docker.js';

const TABLE_NAME = 'restart_repro_rows';
const FULL_SYNC_ROWS = 5_000;
const INCREMENTAL_ROWS = 50_000;
const INSERT_BATCH_SIZE = 1_000;

async function waitForBackgroundSyncAttempt(
  inFlightSync: Promise<{ code: number | null; stdout: string; stderr: string }>,
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return Promise.race([
    inFlightSync,
    sleep(timeoutMs).then(() => ({ code: null, stdout: '', stderr: 'timed out waiting for killed sync request' })),
  ]);
}

async function recreateRestartReproTable(): Promise<void> {
  await mysqlExec(`
    DROP TABLE IF EXISTS ${TABLE_NAME};
    CREATE TABLE ${TABLE_NAME} (
      id INT PRIMARY KEY,
      val VARCHAR(255),
      num DECIMAL(10,2),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
  `);
}

async function seedRestartReproRows(rowCount: number, startId = 1): Promise<void> {
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

describe('Suite 13: Interrupted Incremental Restart', () => {
  beforeAll(async () => {
    await recreateRestartReproTable();
    await seedRestartReproRows(FULL_SYNC_ROWS);
    await triggerFullSync();
  }, 120_000);

  test('restarts mid-incremental-sync on the same persisted ClickHouse state and completes recovery sync', async () => {
    const watermarkBefore = await clickhouseScalarStrict(
      `SELECT last_processed_id AS id FROM appender_watermarks WHERE table_name = '${TABLE_NAME}'`,
      'id',
    );

    expect(Number(watermarkBefore)).toBe(FULL_SYNC_ROWS);

    await sleep(2000);
    await seedRestartReproRows(INCREMENTAL_ROWS, FULL_SYNC_ROWS + 1);

    const inFlightSync = startBackgroundIncrementalSync();

    await waitForDucklingLog('POST /sync/incremental', 10_000);

    await sleep(150);

    killDucklingHard();
    await sleep(1000);
    startDuckling();
    await waitForBackgroundSyncAttempt(inFlightSync);
    await waitForDucklingReady();

    const recoveryResult = await triggerIncrementalSync();
    const finalCount = await clickhouseScalarStrict(
      `SELECT COUNT(*) AS cnt FROM ${TABLE_NAME}`,
      'cnt',
    );
    const logs = getDucklingLogs(1200);
    const containerState = getDucklingContainerState();
    const composeLogs = getDucklingComposeLogs(800);

    expect(recoveryResult?.status ?? 'success').not.toBe('error');
    expect(Number(finalCount)).toBe(FULL_SYNC_ROWS + INCREMENTAL_ROWS);
    expect(logs).toContain('POST /sync/incremental');
    expect(containerState.running).toBe(true);
    expect(containerState.exitCode ?? 0).not.toBe(139);
    expect(composeLogs).not.toContain('Segmentation fault');
  }, 240_000);
});
