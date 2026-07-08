import { describe, test, expect } from 'vitest';
import { clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerFullSync, triggerTableSync } from './helpers/sync.js';

/**
 * Suite 16: unique-constraint edge cases.
 *
 * ClickHouse enforces no unique constraint — duckling dedups at read time via
 * the projection view. This suite verifies that dedup keys correctly on:
 *   - a PRIMARY KEY when a secondary UNIQUE index is also present, and
 *   - a UNIQUE index when the table has NO primary key (the fallback that
 *     stops PK-less tables accumulating duplicate rows on incremental re-sync).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Suite 16: Unique constraint edge cases', () => {
  test('full sync seeds both tables', async () => {
    await triggerFullSync();
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM pk_with_unique', 'cnt')).toBe('2');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM no_pk_unique', 'cnt')).toBe('2');
  });

  // ---- Secondary UNIQUE index alongside a PRIMARY KEY: dedup keys on the PK ----
  describe('secondary UNIQUE index with a primary key', () => {
    test('changing a UNIQUE column value reflects without duplicating the row', async () => {
      await sleep(1200);
      await mysqlExec(
        `UPDATE pk_with_unique SET email = 'alice2@example.com', updated_at = NOW() WHERE id = 1;`,
      );
      await triggerTableSync('pk_with_unique');

      expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM pk_with_unique', 'cnt')).toBe('2');
      expect(
        await clickhouseScalarStrict("SELECT email FROM pk_with_unique WHERE id = 1", 'email'),
      ).toBe('alice2@example.com');
    });

    test('two distinct primary keys are never collapsed by dedup', async () => {
      expect(
        await clickhouseScalarStrict('SELECT COUNT(DISTINCT id) AS cnt FROM pk_with_unique', 'cnt'),
      ).toBe('2');
    });

    test('idempotent re-sync keeps exactly one row per primary key', async () => {
      await sleep(1200);
      await mysqlExec(`UPDATE pk_with_unique SET name = 'Alice v2', updated_at = NOW() WHERE id = 1;`);
      await triggerTableSync('pk_with_unique');
      await triggerTableSync('pk_with_unique'); // re-run re-reads the boundary row (>=)

      expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM pk_with_unique', 'cnt')).toBe('2');
      expect(
        await clickhouseScalarStrict("SELECT name FROM pk_with_unique WHERE id = 1", 'name'),
      ).toBe('Alice v2');
    });
  });

  // ---- UNIQUE key WITHOUT a primary key: dedup falls back to the UNIQUE key ----
  describe('UNIQUE key without a primary key', () => {
    test('incremental UPDATE does not accumulate duplicates (dedup on the UNIQUE key)', async () => {
      await sleep(1200);
      await mysqlExec(`UPDATE no_pk_unique SET qty = 99, updated_at = NOW() WHERE sku = 'SKU-A';`);
      await triggerTableSync('no_pk_unique');

      // Correct behaviour: still one row per sku, latest qty. Without the
      // UNIQUE-key dedup fallback this would be 3 (re-read boundary row appended).
      expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM no_pk_unique', 'cnt')).toBe('2');
      expect(
        await clickhouseScalarStrict("SELECT qty FROM no_pk_unique WHERE sku = 'SKU-A'", 'qty'),
      ).toBe('99');
    });

    test('repeated incremental syncs stay idempotent (one row per UNIQUE key)', async () => {
      await sleep(1200);
      await mysqlExec(`UPDATE no_pk_unique SET qty = 123, updated_at = NOW() WHERE sku = 'SKU-B';`);
      await triggerTableSync('no_pk_unique');
      await triggerTableSync('no_pk_unique');

      expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM no_pk_unique', 'cnt')).toBe('2');
      expect(
        await clickhouseScalarStrict('SELECT COUNT(DISTINCT sku) AS cnt FROM no_pk_unique', 'cnt'),
      ).toBe('2');
      expect(
        await clickhouseScalarStrict("SELECT qty FROM no_pk_unique WHERE sku = 'SKU-B'", 'qty'),
      ).toBe('123');
    });
  });
});
