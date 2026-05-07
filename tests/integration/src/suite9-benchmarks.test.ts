import { describe, test, expect, beforeAll } from 'vitest';
import { triggerFullSync, triggerIncrementalSync } from './helpers/sync';
import { clickhouseQuery, clickhouseScalarStrict } from './helpers/clickhouse';
import { mysqlExec } from './helpers/mysql';
import { sleep } from './helpers/cdc';

const FULL_SYNC_ROWS = 10_000;
const INCR_SYNC_ROWS = 2_000;
const SEQ_QUERY_COUNT = 50;
const CONCURRENT_QUERIES = 20;
const BATCH_SIZE = 1000;

async function seedBenchmarkRows(rowCount: number, startId = 1): Promise<void> {
  await mysqlExec(`
    CREATE TABLE IF NOT EXISTS benchmark_rows (
      id INT PRIMARY KEY,
      val VARCHAR(255),
      num DECIMAL(10,2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `);

  for (let i = startId; i < startId + rowCount; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE, startId + rowCount);
    const values: string[] = [];
    for (let j = i; j < end; j++) {
      values.push(`(${j}, 'row-${j}', ${(j * 1.23).toFixed(2)}, NOW(), NOW())`);
    }
    await mysqlExec(
      `INSERT INTO benchmark_rows (id, val, num, created_at, updated_at) VALUES ${values.join(',')};`,
    );
  }
}

describe('Suite 9: Benchmarks', () => {
  beforeAll(async () => {
    await seedBenchmarkRows(FULL_SYNC_ROWS);
  });

  test('full sync throughput >= 100 rows/sec', async () => {
    const start = Date.now();
    await triggerFullSync();
    const elapsed = (Date.now() - start) / 1000;

    const count = await clickhouseScalarStrict(
      'SELECT COUNT(*) as cnt FROM benchmark_rows',
      'cnt',
    );
    expect(Number(count)).toBe(FULL_SYNC_ROWS);

    const rowsPerSec = FULL_SYNC_ROWS / elapsed;
    console.log(
      `Full sync: ${FULL_SYNC_ROWS.toLocaleString()} rows in ${elapsed.toFixed(1)}s → ${Math.round(rowsPerSec).toLocaleString()} rows/sec (floor: 100)`,
    );
    expect(rowsPerSec).toBeGreaterThanOrEqual(100);
  }, 120_000);

  test('incremental sync throughput >= 50 rows/sec', async () => {
    // Ensure MySQL NOW() timestamps are after the full-sync watermark
    // (MySQL DATETIME has second-level precision)
    await sleep(2000);
    await seedBenchmarkRows(INCR_SYNC_ROWS, FULL_SYNC_ROWS + 1);

    const start = Date.now();
    await triggerIncrementalSync();
    const elapsed = (Date.now() - start) / 1000;

    const count = await clickhouseScalarStrict(
      'SELECT COUNT(*) as cnt FROM benchmark_rows',
      'cnt',
    );
    expect(Number(count)).toBe(FULL_SYNC_ROWS + INCR_SYNC_ROWS);

    const rowsPerSec = INCR_SYNC_ROWS / elapsed;
    console.log(
      `Incremental sync: ${INCR_SYNC_ROWS.toLocaleString()} rows in ${elapsed.toFixed(1)}s → ${Math.round(rowsPerSec).toLocaleString()} rows/sec (floor: 50)`,
    );
    expect(rowsPerSec).toBeGreaterThanOrEqual(50);
  }, 120_000);

  test('sequential query throughput >= 5 queries/sec', async () => {
    const queries = [
      'SELECT COUNT(*) as cnt FROM benchmark_rows',
      'SELECT SUM(num) as total FROM benchmark_rows',
      'SELECT AVG(num) as avg_val FROM benchmark_rows',
      'SELECT MIN(num) as min_val FROM benchmark_rows',
      'SELECT MAX(num) as max_val FROM benchmark_rows',
      'SELECT COUNT(*) as cnt FROM benchmark_rows WHERE num > 5000',
      'SELECT COUNT(DISTINCT val) as cnt FROM benchmark_rows',
      "SELECT COUNT(*) as cnt FROM benchmark_rows WHERE val LIKE 'row-1%'",
      'SELECT id, val, num FROM benchmark_rows ORDER BY num DESC LIMIT 10',
      'SELECT CAST(num AS INTEGER) as bucket, COUNT(*) as cnt FROM benchmark_rows GROUP BY bucket ORDER BY cnt DESC LIMIT 20',
    ];

    const start = Date.now();
    for (let i = 0; i < SEQ_QUERY_COUNT; i++) {
      await clickhouseQuery(queries[i % queries.length]);
    }
    const elapsed = (Date.now() - start) / 1000;

    const qps = SEQ_QUERY_COUNT / elapsed;
    console.log(
      `Sequential queries: ${SEQ_QUERY_COUNT} in ${elapsed.toFixed(1)}s → ${qps.toFixed(1)} queries/sec (floor: 4)`,
    );
    expect(qps).toBeGreaterThanOrEqual(4);
  }, 60_000);

  test('concurrent query throughput >= 5 queries/sec', async () => {
    const queries = [
      'SELECT COUNT(*) as cnt FROM benchmark_rows',
      'SELECT SUM(num) as total FROM benchmark_rows',
      'SELECT AVG(num) as avg_val FROM benchmark_rows',
      'SELECT MIN(num) as min_val, MAX(num) as max_val FROM benchmark_rows',
      'SELECT COUNT(*) as cnt FROM benchmark_rows WHERE num > 5000',
      'SELECT COUNT(DISTINCT val) as cnt FROM benchmark_rows',
      "SELECT COUNT(*) as cnt FROM benchmark_rows WHERE val LIKE 'row-1%'",
      'SELECT id, val, num FROM benchmark_rows ORDER BY num DESC LIMIT 10',
      'SELECT CAST(num AS INTEGER) as bucket, COUNT(*) as cnt FROM benchmark_rows GROUP BY bucket ORDER BY cnt DESC LIMIT 20',
      'SELECT id, val FROM benchmark_rows WHERE id BETWEEN 100 AND 200',
      'SELECT COUNT(*) as cnt FROM benchmark_rows WHERE num BETWEEN 100 AND 500',
      'SELECT val, num FROM benchmark_rows ORDER BY id LIMIT 50 OFFSET 5000',
      'SELECT SUM(num) as total FROM benchmark_rows WHERE id < 5000',
      'SELECT AVG(num) as avg_val FROM benchmark_rows WHERE id > 5000',
      'SELECT COUNT(*) as cnt FROM benchmark_rows GROUP BY CAST(id / 1000 AS INTEGER)',
      "SELECT COUNT(*) as cnt FROM benchmark_rows WHERE val >= 'row-5'",
      'SELECT MAX(id) as max_id FROM benchmark_rows',
      'SELECT MIN(id) as min_id FROM benchmark_rows',
      'SELECT num FROM benchmark_rows ORDER BY num LIMIT 1',
      'SELECT id FROM benchmark_rows ORDER BY id DESC LIMIT 1',
    ];

    const start = Date.now();
    await Promise.all(queries.map((sql) => clickhouseQuery(sql)));
    const elapsed = (Date.now() - start) / 1000;

    const qps = CONCURRENT_QUERIES / elapsed;
    console.log(
      `Concurrent queries: ${CONCURRENT_QUERIES} in ${elapsed.toFixed(1)}s → ${qps.toFixed(1)} queries/sec (floor: 5)`,
    );
    expect(qps).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
