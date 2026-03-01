import { describe, test, expect } from 'vitest';
import { duckdbQuery, duckdbScalarStrict } from './helpers/duckdb.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerFullSync, triggerTableSync } from './helpers/sync.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Suite 8: Composite Primary Key', () => {
  test('trigger full sync and verify seeded composite rows', async () => {
    await triggerFullSync();

    expect(
      await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM composite_keyset_test', 'cnt'),
    ).toBe('6');
    expect(
      await duckdbScalarStrict(
        "SELECT payload FROM composite_keyset_test WHERE a = 1 AND b = 10",
        'payload',
      ),
    ).toBe('seed-1-10');
  });

  test('incremental insert works for composite PK table', async () => {
    // Keep NOW() clearly after the last watermark.
    await sleep(1200);

    mysqlExec(`
      INSERT INTO composite_keyset_test (a, b, payload, created_at, updated_at)
      VALUES (5, 30, 'inc-insert-5-30', NOW(), NOW());
    `);

    await triggerTableSync('composite_keyset_test');

    expect(
      await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM composite_keyset_test', 'cnt'),
    ).toBe('7');
    expect(
      await duckdbScalarStrict(
        "SELECT payload FROM composite_keyset_test WHERE a = 5 AND b = 30",
        'payload',
      ),
    ).toBe('inc-insert-5-30');
  });

  test('incremental update upserts correctly with composite PK', async () => {
    // Keep NOW() clearly after the last watermark.
    await sleep(1200);

    mysqlExec(`
      UPDATE composite_keyset_test
      SET payload = 'inc-update-2-20', updated_at = NOW()
      WHERE a = 2 AND b = 20;
    `);

    await triggerTableSync('composite_keyset_test');

    expect(
      await duckdbScalarStrict(
        "SELECT payload FROM composite_keyset_test WHERE a = 2 AND b = 20",
        'payload',
      ),
    ).toBe('inc-update-2-20');
    // UPDATE should not create new rows.
    expect(
      await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM composite_keyset_test', 'cnt'),
    ).toBe('7');
  });

  test('same-timestamp bulk incremental sync (> batch size) is complete for composite PK', async () => {
    const before = Number(
      await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM composite_keyset_test', 'cnt'),
    );

    // Keep NOW() clearly after the last watermark so all rows are eligible.
    await sleep(1200);

    // Insert 1005 rows with identical updated_at in one statement.
    // This forces pagination over many rows with the same watermark value.
    mysqlExec(`
      INSERT INTO composite_keyset_test (a, b, payload, created_at, updated_at)
      SELECT nums.n, 9000, CONCAT('bulk-', nums.n), NOW(), NOW()
      FROM (
        SELECT
          u.n + (t.n * 10) + (h.n * 100) + (th.n * 1000) + 1 AS n
        FROM
          (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) u
          CROSS JOIN
          (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t
          CROSS JOIN
          (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) h
          CROSS JOIN
          (SELECT 0 AS n UNION ALL SELECT 1) th
      ) nums
      WHERE nums.n <= 1005;
    `);

    await triggerTableSync('composite_keyset_test');

    const after = Number(
      await duckdbScalarStrict('SELECT COUNT(*) AS cnt FROM composite_keyset_test', 'cnt'),
    );
    expect(after).toBe(before + 1005);

    // Validate edge rows from the bulk insert exist.
    expect(
      await duckdbScalarStrict(
        "SELECT payload FROM composite_keyset_test WHERE a = 1 AND b = 9000",
        'payload',
      ),
    ).toBe('bulk-1');
    expect(
      await duckdbScalarStrict(
        "SELECT payload FROM composite_keyset_test WHERE a = 1005 AND b = 9000",
        'payload',
      ),
    ).toBe('bulk-1005');

    // Ensure we didn't lose rows in pagination.
    const counts = await duckdbQuery(`
      SELECT
        COUNT(*) AS total_rows,
        COUNT(DISTINCT CAST(b AS VARCHAR) || ':' || CAST(a AS VARCHAR)) AS distinct_keys
      FROM composite_keyset_test
      WHERE b = 9000
    `);

    const row = counts.result[0];
    expect(String(row.total_rows)).toBe('1005');
    expect(String(row.distinct_keys)).toBe('1005');
  });
});
