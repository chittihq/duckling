import { describe, test, expect } from 'vitest';
import { clickhouseQuery, clickhouseScalar, clickhouseScalarStrict, normalizeDecimal } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerTableSync } from './helpers/sync.js';
import { cdcStart, cdcStop, cdcStatus, waitForCdcRunning, waitForCdc, sleep } from './helpers/cdc.js';
import { DB_ID, TIMEOUT_CDC } from './helpers/config.js';

describe('Suite 6: CDC Real-Time Replication', () => {
  const CDC_PRODUCT_ID = 7007;
  const CDC_EVENT_ID = 7005;
  const RESTART_PRODUCT_ID = 7009;
  const STOPPED_PRODUCT_ID = 7008;
  const CHECKPOINT_PRODUCT_ID = 7010;
  const CHECKPOINT_ADVANCE_ID = 7011;
  const TYPE_COVERAGE_CDC_ID = 7001;
  let productsBaseline: number;
  let eventsBaseline: number;

  test('CDC starts successfully', async () => {
    await cdcStart();
    const running = await waitForCdcRunning();
    expect(running).toBe(true);
  });

  test('record baselines', async () => {
    productsBaseline = Number(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt'));
    eventsBaseline = Number(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt'));
  });

  // --- CDC INSERT ---
  describe('CDC INSERT', () => {
    test('products_simple INSERT detected', async () => {
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${CDC_PRODUCT_ID};`);
      await mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (${CDC_PRODUCT_ID}, 'CDC Widget', 19.99, 50, NOW());
      `);

      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM products_simple',
        'cnt',
        String(productsBaseline + 1),
      );
      expect(detected).toBe(true);
    });

    test('CDC Widget name in DuckDB', async () => {
      expect(await clickhouseScalarStrict(`SELECT name FROM products_simple WHERE id = ${CDC_PRODUCT_ID}`, 'name')).toBe('CDC Widget');
    });

    test('CDC Widget price', async () => {
      const raw = await clickhouseScalarStrict(
        `SELECT CAST(price AS DOUBLE) AS p FROM products_simple WHERE id = ${CDC_PRODUCT_ID}`,
        'p',
      );
      expect(normalizeDecimal(raw)).toBe('19.99');
    });

    test('events_append_only INSERT detected', async () => {
      await mysqlExec(`DELETE FROM events_append_only WHERE id = ${CDC_EVENT_ID};`);
      await mysqlExec(`
        INSERT INTO events_append_only (id, event_type, payload, amount, created_at)
        VALUES (${CDC_EVENT_ID}, 'cdc_test', '{"source":"cdc"}', 42.5000, NOW());
      `);

      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM events_append_only',
        'cnt',
        String(eventsBaseline + 1),
      );
      expect(detected).toBe(true);
    });

    test('CDC event_type in DuckDB', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT event_type FROM events_append_only WHERE id = ${CDC_EVENT_ID}`, 'event_type'),
      ).toBe('cdc_test');
    });
  });

  // --- CDC UPDATE ---
  describe('CDC UPDATE', () => {
    test('products_simple UPDATE detected', async () => {
      await mysqlExec(`UPDATE products_simple SET price = 24.99, quantity = 40 WHERE id = ${CDC_PRODUCT_ID};`);

      const detected = await waitForCdc(
        `SELECT CAST(price AS DOUBLE) AS p FROM products_simple WHERE id = ${CDC_PRODUCT_ID}`,
        'p',
        '24.99',
      );
      expect(detected).toBe(true);
    });

    test('CDC updated quantity', async () => {
      expect(await clickhouseScalarStrict(`SELECT quantity FROM products_simple WHERE id = ${CDC_PRODUCT_ID}`, 'quantity')).toBe('40');
    });

    test('products count unchanged after CDC UPDATE', async () => {
      expect(
        await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt'),
      ).toBe(String(productsBaseline + 1));
    });
  });

  // --- CDC DELETE ---
  describe('CDC DELETE', () => {
    test('products_simple DELETE detected', async () => {
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${CDC_PRODUCT_ID};`);

      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM products_simple',
        'cnt',
        String(productsBaseline),
      );
      expect(detected).toBe(true);
    });

    test('CDC deleted row not queryable', async () => {
      const val = await clickhouseScalar(`SELECT name FROM products_simple WHERE id = ${CDC_PRODUCT_ID}`, 'name');
      expect(val).toBe('null');
    });
  });

  // --- CDC Stop/Restart durability (6b) ---
  describe('CDC restart durability (6b)', () => {
    let preRestartCount: string;

    test('binlog position was checkpointed', async () => {
      preRestartCount = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt');

      const binlogFile = await clickhouseScalarStrict(
        `SELECT filename FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'filename',
      );
      expect(binlogFile).not.toBe('null');
    });

    test('CDC restarts and picks up missed row', async () => {
      // Stop CDC
      await cdcStop();
      await sleep(1000);

      // Insert while CDC is stopped
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${RESTART_PRODUCT_ID};`);
      await mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (${RESTART_PRODUCT_ID}, 'Restart Test', 9.99, 5, NOW());
      `);

      // Restart CDC
      await cdcStart();
      const running = await waitForCdcRunning();
      expect(running).toBe(true);

      // Row inserted while stopped should arrive via binlog replay
      const expected = String(Number(preRestartCount) + 1);
      const detected = await waitForCdc('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt', expected);
      expect(detected).toBe(true);
    });

    test('Restart row name correct', async () => {
      expect(await clickhouseScalarStrict(`SELECT name FROM products_simple WHERE id = ${RESTART_PRODUCT_ID}`, 'name')).toBe('Restart Test');
    });

    test('cleanup restart test row', async () => {
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${RESTART_PRODUCT_ID};`);
      // Best-effort wait — bash used || true
      await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM products_simple',
        'cnt',
        String(productsBaseline),
      );
    });
  });

  // --- CDC Stats ---
  describe('CDC stats', () => {
    test('eventsProcessed > 0', async () => {
      const resp = await cdcStatus();
      expect(Number(resp?.status?.eventsProcessed ?? 0)).toBeGreaterThan(0);
    });

    test('insertsProcessed >= 1', async () => {
      const resp = await cdcStatus();
      expect(Number(resp?.status?.insertsProcessed ?? 0)).toBeGreaterThanOrEqual(1);
    });

    test('updatesProcessed is non-negative', async () => {
      const resp = await cdcStatus();
      const updates = Number(resp?.status?.updatesProcessed ?? 0);
      expect(Number.isFinite(updates)).toBe(true);
      expect(updates).toBeGreaterThanOrEqual(0);
    });

    test('deletesProcessed >= 1', async () => {
      const resp = await cdcStatus();
      expect(Number(resp?.status?.deletesProcessed ?? 0)).toBeGreaterThanOrEqual(1);
    });
  });

  // --- CDC Type Fidelity INSERT ---
  describe('CDC type fidelity', () => {
    test('type_coverage_cdc INSERT detected', async () => {
      await mysqlExec(`DELETE FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID};`);
      await mysqlExec(`
        SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '');
        INSERT INTO type_coverage_cdc (
          id, col_tinyint_signed, col_smallint, col_mediumint,
          col_int_unsigned, col_bigint_unsigned,
          col_double, col_decimal_5_0, col_decimal_20_10,
          col_char_10, col_tinytext, col_mediumtext, col_longtext,
          col_date, col_time, col_timestamp, col_datetime_6, col_year, col_set,
          col_json, col_enum, col_boolean, col_utf8_emoji, col_date_zero,
          created_at, updated_at
        ) VALUES (
          ${TYPE_COVERAGE_CDC_ID}, -42, 1000, 500000,
          3000000000, 9999999999,
          2.71828, 12345, 9876543210.1234500000,
          'CDC-TEST', 'cdc tiny', 'cdc medium text', 'cdc long text',
          '2024-12-25', '14:30:00', '2025-06-15 12:00:00', '2025-06-15 12:00:00.123456', 2024, 'b,d',
          '{"cdc":true,"items":[1,2,3]}', 'beta', TRUE, 'CDC 🦆 emoji', '0000-00-00',
          NOW(), NOW()
        );
      `);

      const detected = await waitForCdc('SELECT COUNT(*) AS cnt FROM type_coverage_cdc', 'cnt', '1');
      expect(detected).toBe(true);
    });

    test('CDC type TINYINT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_tinyint_signed FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_tinyint_signed'),
      ).toBe('-42');
    });

    test('CDC type SMALLINT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_smallint FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_smallint'),
      ).toBe('1000');
    });

    test('CDC type MEDIUMINT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_mediumint FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_mediumint'),
      ).toBe('500000');
    });

    test('CDC type INT UNSIGNED', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_int_unsigned FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_int_unsigned'),
      ).toBe('3000000000');
    });

    test('CDC type DOUBLE', async () => {
      const val = await clickhouseScalarStrict(
        `SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`,
        'v',
      );
      expect(val).toContain('2.71828');
    });

    test('CDC type DECIMAL(5,0)', async () => {
      const raw = await clickhouseScalarStrict(
        `SELECT col_decimal_5_0 FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`,
        'col_decimal_5_0',
      );
      expect(normalizeDecimal(raw)).toBe('12345');
    });

    test('CDC type CHAR(10)', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_char_10 FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_char_10'),
      ).toBe('CDC-TEST');
    });

    test('CDC type TINYTEXT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_tinytext FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_tinytext'),
      ).toBe('cdc tiny');
    });

    test('CDC type MEDIUMTEXT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_mediumtext FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_mediumtext'),
      ).toBe('cdc medium text');
    });

    test('CDC type LONGTEXT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_longtext FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_longtext'),
      ).toBe('cdc long text');
    });

    test('CDC type YEAR', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_year FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_year'),
      ).toBe('2024');
    });

    test('CDC type SET', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_set FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_set'),
      ).toBe('b,d');
    });

    test('CDC type DATE', async () => {
      const val = await clickhouseScalarStrict(
        `SELECT CAST(col_date AS VARCHAR) AS v FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`,
        'v',
      );
      expect(val).toContain('2024-12-25');
    });

    test('CDC type JSON', async () => {
      const raw = await clickhouseScalarStrict(`SELECT col_json FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_json');
      const parsed = JSON.parse(raw);
      expect(parsed.cdc).toBe(true);
      expect(parsed.items).toEqual([1, 2, 3]);
    });

    test('CDC type ENUM', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_enum FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_enum'),
      ).toBe('beta');
    });

    test('CDC type BOOLEAN', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_boolean FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_boolean'),
      ).toBe('1');
    });

    test('CDC type UTF-8 emoji', async () => {
      const val = await clickhouseScalarStrict(`SELECT col_utf8_emoji FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_utf8_emoji');
      expect(val).toContain('🦆');
      expect(val).toBe('CDC 🦆 emoji');
    });

    test('CDC type zero date becomes null', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_date_zero FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_date_zero'),
      ).toBe('null');
    });

    // --- CDC Type Fidelity UPDATE ---
    test('type_coverage_cdc UPDATE detected', async () => {
      await mysqlExec(`
        UPDATE type_coverage_cdc SET
          col_tinyint_signed = 127,
          col_smallint = 32767,
          col_double = -1.0,
          col_char_10 = 'UPDATED',
          col_set = 'a,b,c',
          col_json = '{"updated":true}',
          col_enum = 'delta',
          col_boolean = FALSE,
          updated_at = NOW()
        WHERE id = ${TYPE_COVERAGE_CDC_ID};
      `);

      const detected = await waitForCdc(
        `SELECT col_tinyint_signed FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`,
        'col_tinyint_signed',
        '127',
      );
      expect(detected).toBe(true);
    });

    test('CDC updated SMALLINT', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_smallint FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_smallint'),
      ).toBe('32767');
    });

    test('CDC updated DOUBLE', async () => {
      const val = await clickhouseScalarStrict(
        `SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`,
        'v',
      );
      expect(val === '-1' || val.includes('-1.0')).toBe(true);
    });

    test('CDC updated CHAR(10)', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_char_10 FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_char_10'),
      ).toBe('UPDATED');
    });

    test('CDC updated SET', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_set FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_set'),
      ).toBe('a,b,c');
    });

    test('CDC updated JSON', async () => {
      const raw = await clickhouseScalarStrict(`SELECT col_json FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_json');
      const parsed = JSON.parse(raw);
      expect(parsed.updated).toBe(true);
    });

    test('CDC updated ENUM', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_enum FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_enum'),
      ).toBe('delta');
    });

    test('CDC updated BOOLEAN', async () => {
      expect(
        await clickhouseScalarStrict(`SELECT col_boolean FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID}`, 'col_boolean'),
      ).toBe('0');
    });

    test('cleanup type_coverage_cdc row', async () => {
      await mysqlExec(`DELETE FROM type_coverage_cdc WHERE id = ${TYPE_COVERAGE_CDC_ID};`);
      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM type_coverage_cdc',
        'cnt',
        '0',
      );
      expect(detected).toBe(true);
    });
  });

  // --- CDC Stop behavior ---
  describe('CDC stop behavior', () => {
    test('CDC stops', async () => {
      await cdcStop();
      const resp = await cdcStatus();
      expect(resp?.status?.isRunning).toBe(false);
    });

    test('no replication after stop', async () => {
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${STOPPED_PRODUCT_ID};`);
      await mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (${STOPPED_PRODUCT_ID}, 'After Stop', 5.00, 10, NOW());
      `);

      await sleep(3000);

      const val = await clickhouseScalar(`SELECT name FROM products_simple WHERE id = ${STOPPED_PRODUCT_ID}`, 'name');
      expect(val).toBe('null');
    });
  });

  // --- Checkpoint safety on apply failure (6c) ---
  describe('Checkpoint safety on apply failure (6c)', () => {
    let preFailFile: string;
    let preFailPos: string;
    let postFailPos: string;

    test('record pre-fail checkpoint', async () => {
      preFailFile = await clickhouseScalarStrict(
        `SELECT filename FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'filename',
      );
      preFailPos = await clickhouseScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      expect(preFailFile).not.toBe('null');
      expect(preFailPos).not.toBe('null');
    });

    test('checkpoint does not advance past failed apply', async () => {
      // Drop the DuckDB table to cause a real apply failure
      await clickhouseQuery('DROP TABLE IF EXISTS products_simple').catch(() => {});

      // Insert a row — CDC will try (and fail) to apply this event
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${CHECKPOINT_PRODUCT_ID};`);
      await mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (${CHECKPOINT_PRODUCT_ID}, 'Checkpoint Test', 1.00, 1, NOW());
      `);

      // Start CDC — resumes from checkpoint, reads the INSERT event, fails on missing table
      await cdcStart();
      await waitForCdcRunning();

      // Give CDC time to read the binlog event and hit the apply failure
      await sleep(5000);

      // CRITICAL: checkpoint must NOT advance past the failed event
      postFailPos = await clickhouseScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      expect(postFailPos).not.toBe('null');
      expect(Number(postFailPos)).toBeLessThanOrEqual(Number(preFailPos));
    });

    test('CDC error count increases', async () => {
      const resp = await cdcStatus();
      expect(Number(resp?.status?.errors ?? 0)).toBeGreaterThan(0);
    });

    test('recovery: table restored via sync', async () => {
      await cdcStop();
      await sleep(1000);

      // Single-table sync recreates the DuckDB table from MySQL (includes id=10)
      await triggerTableSync('products_simple').catch(() => {});

      const restoredCount = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt');
      expect(restoredCount).not.toBe('null');
      expect(restoredCount).not.toBe('0');
    });

    test('recovery: CDC replays from safe checkpoint', async () => {
      await cdcStart();
      const running = await waitForCdcRunning();
      expect(running).toBe(true);

      // Verify the checkpoint-test row is present (via sync or CDC replay)
      const detected = await waitForCdc(
        `SELECT name FROM products_simple WHERE id = ${CHECKPOINT_PRODUCT_ID}`,
        'name',
        'Checkpoint Test',
      );
      if (!detected) {
        // Fallback: already present from sync
        const ctName = await clickhouseScalarStrict(`SELECT name FROM products_simple WHERE id = ${CHECKPOINT_PRODUCT_ID}`, 'name');
        expect(ctName).toBe('Checkpoint Test');
      }

      // Force a post-recovery CDC event so checkpoint advancement is deterministic.
      await mysqlExec(`DELETE FROM products_simple WHERE id = ${CHECKPOINT_ADVANCE_ID};`);
      await mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (${CHECKPOINT_ADVANCE_ID}, 'Checkpoint Advance', 2.00, 2, NOW());
      `);
      const advanceDetected = await waitForCdc(
        `SELECT name FROM products_simple WHERE id = ${CHECKPOINT_ADVANCE_ID}`,
        'name',
        'Checkpoint Advance',
      );
      expect(advanceDetected).toBe(true);
    });

    test('checkpoint advanced after successful recovery', async () => {
      const recoveredPos = await clickhouseScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      expect(Number(recoveredPos)).toBeGreaterThan(Number(postFailPos));
    });

    test('checkpoint monotonicity', async () => {
      const recoveredPos = await clickhouseScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      // post_fail_pos <= pre_fail_pos < recovered_pos
      expect(Number(postFailPos)).toBeLessThanOrEqual(Number(preFailPos));
      expect(Number(recoveredPos)).toBeGreaterThan(Number(preFailPos));
    });

    test('cleanup checkpoint test', async () => {
      await mysqlExec(`DELETE FROM products_simple WHERE id IN (${CHECKPOINT_PRODUCT_ID}, ${CHECKPOINT_ADVANCE_ID}, ${STOPPED_PRODUCT_ID});`);
      await cdcStop();
    });
  });
});
