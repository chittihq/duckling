import { describe, test, expect } from 'vitest';
import { clickhouseScalar, clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerTableSync, waitForSyncIdle } from './helpers/sync.js';
import { cdcStart, cdcStop, cdcStatus, waitForCdc, waitForCdcRunning, sleep } from './helpers/cdc.js';
import { TIMEOUT_CDC } from './helpers/config.js';

/**
 * Suite 17: CDC-lite (binlog tailer augmenting polling mode).
 *
 * The headline case is polling mode's historical delete blind spot: a DELETE
 * paired with an INSERT inside the same polling window keeps the row count
 * unchanged, so the poller takes the incremental path — which can never
 * remove rows. Pre-CDC-lite, the deleted row stayed visible until a full
 * rebuild. The binlog tailer fixes this with tombstones.
 *
 * The integration MySQL runs binlog defaults (log_bin=ON, ROW format,
 * binlog_row_metadata=MINIMAL) — deliberately exercising the MINIMAL path
 * that full PeerDB CDC cannot serve.
 */

const TABLE = 'cdc_lite_orders';

async function waitForGone(id: number, timeoutMs = TIMEOUT_CDC): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cnt = await clickhouseScalar(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE id = ${id}`, 'cnt');
    if (cnt === '0') return true;
    await sleep(500);
  }
  return false;
}

describe('Suite 17: CDC-lite delete tombstones', () => {
  test('setup: seed table and sync it', async () => {
    await mysqlExec(`
      DROP TABLE IF EXISTS ${TABLE};
      CREATE TABLE ${TABLE} (
        id INT PRIMARY KEY,
        item VARCHAR(64) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
      INSERT INTO ${TABLE} (id, item) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma'), (4, 'delta');
    `);
    const result = await triggerTableSync(TABLE);
    expect(result?.success ?? true).toBeTruthy();
    expect(await clickhouseScalarStrict(`SELECT COUNT(*) AS cnt FROM ${TABLE}`, 'cnt')).toBe('4');
  });

  test('CDC (polling + lite) is running', async () => {
    await cdcStart();
    expect(await waitForCdcRunning()).toBe(true);
  });

  test('cdc-lite tailer reports running', async () => {
    // Give the tailer a moment to connect after cdcStart.
    const deadline = Date.now() + 15_000;
    let running = false;
    while (Date.now() < deadline && !running) {
      const resp = await cdcStatus();
      running = resp?.status?.cdcLite?.running === true;
      if (!running) await sleep(1000);
    }
    expect(running).toBe(true);
  });

  test('THE BLIND SPOT: count-neutral delete+insert converges', async () => {
    // One atomic round-trip: row count is unchanged, so the poller's
    // count-drop rebuild can never fire. Only a tombstone removes id=2.
    await mysqlExec(`
      DELETE FROM ${TABLE} WHERE id = 2;
      INSERT INTO ${TABLE} (id, item) VALUES (5, 'epsilon');
    `);

    expect(await waitForGone(2)).toBe(true);
    // The replacement row arrived too (nudge or poller).
    expect(await waitForCdc(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE id = 5`, 'cnt', '1')).toBe(true);
    // Net count is right: 4 - 1 + 1 = 4.
    expect(await waitForCdc(`SELECT COUNT(*) AS cnt FROM ${TABLE}`, 'cnt', '4')).toBe(true);
  });

  test('tombstones were actually written (not a rebuild masking the result)', async () => {
    const resp = await cdcStatus();
    expect(Number(resp?.status?.cdcLite?.tombstonesWritten ?? 0)).toBeGreaterThanOrEqual(1);
  });

  test('plain delete converges', async () => {
    await mysqlExec(`DELETE FROM ${TABLE} WHERE id = 3;`);
    expect(await waitForGone(3)).toBe(true);
    expect(await waitForCdc(`SELECT COUNT(*) AS cnt FROM ${TABLE}`, 'cnt', '3')).toBe(true);
  });

  test('delete then re-insert same PK: row comes back (tombstone does not stick)', async () => {
    await mysqlExec(`
      DELETE FROM ${TABLE} WHERE id = 1;
      INSERT INTO ${TABLE} (id, item) VALUES (1, 'alpha-reborn');
    `);
    expect(await waitForCdc(
      `SELECT item FROM ${TABLE} WHERE id = 1`,
      'item',
      'alpha-reborn',
    )).toBe(true);
  });

  test('cleanup', async () => {
    // Stop CDC (poller + tailer) so later suites start from the same state
    // they would without this suite — suite5's full sync must not race a
    // live poller cycle, and suite6's checkpoint-window assertions assume
    // CDC begins fresh there.
    await cdcStop();
    await sleep(1500);
    // Let any in-flight nudge/poller sync drain before the next suite reads.
    await waitForSyncIdle(30_000);
    await mysqlExec(`DROP TABLE IF EXISTS ${TABLE};`);
  });
});
