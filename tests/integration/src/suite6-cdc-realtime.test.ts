import { describe, test, expect } from 'vitest';
import { duckdbQuery, duckdbScalar, duckdbScalarStrict, normalizeDecimal } from './helpers/duckdb.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerTableSync } from './helpers/sync.js';
import { cdcStart, cdcStop, cdcStatus, waitForCdcRunning, waitForCdc, sleep } from './helpers/cdc.js';
import { DB_ID, TIMEOUT_CDC } from './helpers/config.js';

describe('Suite 6: CDC Real-Time Replication', () => {
  let productsBaseline: number;
  let eventsBaseline: number;

  test('CDC starts successfully', async () => {
    await cdcStart();
    const running = await waitForCdcRunning();
    expect(running).toBe(true);
  });

  test('record baselines', async () => {
    productsBaseline = Number(await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt'));
    eventsBaseline = Number(await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt'));
  });

  // --- CDC INSERT ---
  describe('CDC INSERT', () => {
    test('products_simple INSERT detected', async () => {
      mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (7, 'CDC Widget', 19.99, 50, NOW());
      `);

      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM products_simple',
        'cnt',
        String(productsBaseline + 1),
      );
      expect(detected).toBe(true);
    });

    test('CDC Widget name in DuckDB', async () => {
      expect(await duckdbScalarStrict('SELECT name FROM products_simple WHERE id = 7', 'name')).toBe('CDC Widget');
    });

    test('CDC Widget price', async () => {
      const raw = await duckdbScalarStrict(
        'SELECT CAST(price AS DOUBLE) AS p FROM products_simple WHERE id = 7',
        'p',
      );
      expect(normalizeDecimal(raw)).toBe('19.99');
    });

    test('events_append_only INSERT detected', async () => {
      mysqlExec(`
        INSERT INTO events_append_only (id, event_type, payload, amount, created_at)
        VALUES (5, 'cdc_test', '{"source":"cdc"}', 42.5000, NOW());
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
        await duckdbScalarStrict('SELECT event_type FROM events_append_only WHERE id = 5', 'event_type'),
      ).toBe('cdc_test');
    });
  });

  // --- CDC UPDATE ---
  describe('CDC UPDATE', () => {
    test('products_simple UPDATE detected', async () => {
      mysqlExec(`UPDATE products_simple SET price = 24.99, quantity = 40 WHERE id = 7;`);

      const detected = await waitForCdc(
        'SELECT CAST(price AS DOUBLE) AS p FROM products_simple WHERE id = 7',
        'p',
        '24.99',
      );
      expect(detected).toBe(true);
    });

    test('CDC updated quantity', async () => {
      expect(await duckdbScalarStrict('SELECT quantity FROM products_simple WHERE id = 7', 'quantity')).toBe('40');
    });

    test('products count unchanged after CDC UPDATE', async () => {
      expect(
        await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt'),
      ).toBe(String(productsBaseline + 1));
    });
  });

  // --- CDC DELETE ---
  describe('CDC DELETE', () => {
    test('products_simple DELETE detected', async () => {
      mysqlExec(`DELETE FROM products_simple WHERE id = 7;`);

      const detected = await waitForCdc(
        'SELECT COUNT(*) AS cnt FROM products_simple',
        'cnt',
        String(productsBaseline),
      );
      expect(detected).toBe(true);
    });

    test('CDC deleted row not queryable', async () => {
      const val = await duckdbScalar('SELECT name FROM products_simple WHERE id = 7', 'name');
      expect(val).toBe('null');
    });
  });

  // --- CDC Stop/Restart durability (6b) ---
  describe('CDC restart durability (6b)', () => {
    let preRestartCount: string;

    test('binlog position was checkpointed', async () => {
      preRestartCount = await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt');

      const binlogFile = await duckdbScalarStrict(
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
      mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (9, 'Restart Test', 9.99, 5, NOW());
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
      expect(await duckdbScalarStrict('SELECT name FROM products_simple WHERE id = 9', 'name')).toBe('Restart Test');
    });

    test('cleanup restart test row', async () => {
      mysqlExec(`DELETE FROM products_simple WHERE id = 9;`);
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
      mysqlExec(`
        INSERT INTO type_coverage_cdc (
          id, col_tinyint_signed, col_smallint, col_mediumint,
          col_int_unsigned, col_bigint_unsigned,
          col_double, col_decimal_5_0, col_decimal_20_10,
          col_char_10, col_tinytext, col_mediumtext, col_longtext,
          col_time, col_timestamp, col_datetime_6, col_year, col_set,
          created_at, updated_at
        ) VALUES (
          1, -42, 1000, 500000,
          3000000000, 9999999999,
          2.71828, 12345, 9876543210.1234500000,
          'CDC-TEST', 'cdc tiny', 'cdc medium text', 'cdc long text',
          '14:30:00', '2025-06-15 12:00:00', '2025-06-15 12:00:00.123456', 2024, 'b,d',
          NOW(), NOW()
        );
      `);

      const detected = await waitForCdc('SELECT COUNT(*) AS cnt FROM type_coverage_cdc', 'cnt', '1');
      expect(detected).toBe(true);
    });

    test('CDC type TINYINT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_tinyint_signed FROM type_coverage_cdc WHERE id = 1', 'col_tinyint_signed'),
      ).toBe('-42');
    });

    test('CDC type SMALLINT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_smallint FROM type_coverage_cdc WHERE id = 1', 'col_smallint'),
      ).toBe('1000');
    });

    test('CDC type MEDIUMINT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_mediumint FROM type_coverage_cdc WHERE id = 1', 'col_mediumint'),
      ).toBe('500000');
    });

    test('CDC type INT UNSIGNED', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_int_unsigned FROM type_coverage_cdc WHERE id = 1', 'col_int_unsigned'),
      ).toBe('3000000000');
    });

    test('CDC type DOUBLE', async () => {
      const val = await duckdbScalarStrict(
        'SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage_cdc WHERE id = 1',
        'v',
      );
      expect(val).toContain('2.71828');
    });

    test('CDC type DECIMAL(5,0)', async () => {
      const raw = await duckdbScalarStrict(
        'SELECT col_decimal_5_0 FROM type_coverage_cdc WHERE id = 1',
        'col_decimal_5_0',
      );
      expect(normalizeDecimal(raw)).toBe('12345');
    });

    test('CDC type CHAR(10)', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_char_10 FROM type_coverage_cdc WHERE id = 1', 'col_char_10'),
      ).toBe('CDC-TEST');
    });

    test('CDC type TINYTEXT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_tinytext FROM type_coverage_cdc WHERE id = 1', 'col_tinytext'),
      ).toBe('cdc tiny');
    });

    test('CDC type MEDIUMTEXT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_mediumtext FROM type_coverage_cdc WHERE id = 1', 'col_mediumtext'),
      ).toBe('cdc medium text');
    });

    test('CDC type LONGTEXT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_longtext FROM type_coverage_cdc WHERE id = 1', 'col_longtext'),
      ).toBe('cdc long text');
    });

    test('CDC type YEAR', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_year FROM type_coverage_cdc WHERE id = 1', 'col_year'),
      ).toBe('2024');
    });

    test('CDC type SET', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_set FROM type_coverage_cdc WHERE id = 1', 'col_set'),
      ).toBe('b,d');
    });

    // --- CDC Type Fidelity UPDATE ---
    test('type_coverage_cdc UPDATE detected', async () => {
      mysqlExec(`
        UPDATE type_coverage_cdc SET
          col_tinyint_signed = 127,
          col_smallint = 32767,
          col_double = -1.0,
          col_char_10 = 'UPDATED',
          col_set = 'a,b,c',
          updated_at = NOW()
        WHERE id = 1;
      `);

      const detected = await waitForCdc(
        'SELECT col_tinyint_signed FROM type_coverage_cdc WHERE id = 1',
        'col_tinyint_signed',
        '127',
      );
      expect(detected).toBe(true);
    });

    test('CDC updated SMALLINT', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_smallint FROM type_coverage_cdc WHERE id = 1', 'col_smallint'),
      ).toBe('32767');
    });

    test('CDC updated DOUBLE', async () => {
      const val = await duckdbScalarStrict(
        'SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage_cdc WHERE id = 1',
        'v',
      );
      expect(val).toContain('-1.0');
    });

    test('CDC updated CHAR(10)', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_char_10 FROM type_coverage_cdc WHERE id = 1', 'col_char_10'),
      ).toBe('UPDATED');
    });

    test('CDC updated SET', async () => {
      expect(
        await duckdbScalarStrict('SELECT col_set FROM type_coverage_cdc WHERE id = 1', 'col_set'),
      ).toBe('a,b,c');
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
      mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (8, 'After Stop', 5.00, 10, NOW());
      `);

      await sleep(3000);

      const val = await duckdbScalar('SELECT name FROM products_simple WHERE id = 8', 'name');
      expect(val).toBe('null');
    });
  });

  // --- Checkpoint safety on apply failure (6c) ---
  describe('Checkpoint safety on apply failure (6c)', () => {
    let preFailFile: string;
    let preFailPos: string;
    let postFailPos: string;

    test('record pre-fail checkpoint', async () => {
      preFailFile = await duckdbScalarStrict(
        `SELECT filename FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'filename',
      );
      preFailPos = await duckdbScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      expect(preFailFile).not.toBe('null');
      expect(preFailPos).not.toBe('null');
    });

    test('checkpoint does not advance past failed apply', async () => {
      // Drop the DuckDB table to cause a real apply failure
      await duckdbQuery('DROP TABLE IF EXISTS products_simple').catch(() => {});

      // Insert a row — CDC will try (and fail) to apply this event
      mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (10, 'Checkpoint Test', 1.00, 1, NOW());
      `);

      // Start CDC — resumes from checkpoint, reads the INSERT event, fails on missing table
      await cdcStart();
      await waitForCdcRunning();

      // Give CDC time to read the binlog event and hit the apply failure
      await sleep(5000);

      // CRITICAL: checkpoint must NOT advance past the failed event
      postFailPos = await duckdbScalarStrict(
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

      const restoredCount = await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt');
      expect(restoredCount).not.toBe('null');
      expect(restoredCount).not.toBe('0');
    });

    test('recovery: CDC replays from safe checkpoint', async () => {
      await cdcStart();
      const running = await waitForCdcRunning();
      expect(running).toBe(true);

      // Verify the checkpoint-test row is present (via sync or CDC replay)
      const detected = await waitForCdc(
        'SELECT name FROM products_simple WHERE id = 10',
        'name',
        'Checkpoint Test',
      );
      if (!detected) {
        // Fallback: already present from sync
        const ctName = await duckdbScalarStrict('SELECT name FROM products_simple WHERE id = 10', 'name');
        expect(ctName).toBe('Checkpoint Test');
      }

      // Force a post-recovery CDC event so checkpoint advancement is deterministic.
      mysqlExec(`
        INSERT INTO products_simple (id, name, price, quantity, updated_at)
        VALUES (11, 'Checkpoint Advance', 2.00, 2, NOW());
      `);
      const advanceDetected = await waitForCdc(
        'SELECT name FROM products_simple WHERE id = 11',
        'name',
        'Checkpoint Advance',
      );
      expect(advanceDetected).toBe(true);
    });

    test('checkpoint advanced after successful recovery', async () => {
      const recoveredPos = await duckdbScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      expect(Number(recoveredPos)).toBeGreaterThan(Number(postFailPos));
    });

    test('checkpoint monotonicity', async () => {
      const recoveredPos = await duckdbScalarStrict(
        `SELECT position FROM cdc_binlog_position WHERE database_id = '${DB_ID}'`,
        'position',
      );
      // post_fail_pos <= pre_fail_pos < recovered_pos
      expect(Number(postFailPos)).toBeLessThanOrEqual(Number(preFailPos));
      expect(Number(recoveredPos)).toBeGreaterThan(Number(preFailPos));
    });

    test('cleanup checkpoint test', async () => {
      mysqlExec(`DELETE FROM products_simple WHERE id IN (10, 11);`);
      await cdcStop();
    });
  });
});
