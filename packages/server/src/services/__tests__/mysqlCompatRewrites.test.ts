import { describe, expect, test } from 'vitest';
import { applyMysqlCompatRewrites } from '../mysqlQueryRouter';

/**
 * These rewrites exist because ClickHouse rejects a handful of MySQL
 * constructs outright. Every case here was verified against a real
 * clickhouse-server:25.8 (the version the deploy compose pins): the "before"
 * form raises UNKNOWN_IDENTIFIER / UNKNOWN_FUNCTION, the "after" form works.
 *
 * The rewrites must be a strict widening — never change a query that already
 * worked, and never touch string literals.
 */

describe('MySQL compatibility rewrites', () => {
  test('bare CURRENT_DATE becomes a function call', () => {
    const { sql, applied } = applyMysqlCompatRewrites(
      'SELECT * FROM t WHERE createdAt >= CURRENT_DATE - INTERVAL 7 DAY'
    );
    expect(sql).toContain('CURRENT_DATE()');
    expect(applied.length).toBe(1);
  });

  test('bare CURRENT_TIMESTAMP becomes a function call', () => {
    const { sql } = applyMysqlCompatRewrites('SELECT CURRENT_TIMESTAMP');
    expect(sql).toBe('SELECT CURRENT_TIMESTAMP()');
  });

  test('UNIX_TIMESTAMP maps to toUnixTimestamp', () => {
    const { sql } = applyMysqlCompatRewrites('SELECT UNIX_TIMESTAMP(createdAt) FROM t');
    expect(sql).toBe('SELECT toUnixTimestamp(createdAt) FROM t');
  });

  test('already-correct forms are left alone (no double rewriting)', () => {
    const inputs = [
      'SELECT CURRENT_DATE()',
      'SELECT CURRENT_TIMESTAMP()',
      'SELECT toUnixTimestamp(now())',
    ];
    for (const input of inputs) {
      const { sql, applied } = applyMysqlCompatRewrites(input);
      expect(sql).toBe(input);
      expect(applied).toEqual([]);
    }
  });

  test('string literals are never rewritten', () => {
    const input = "SELECT * FROM t WHERE label = 'CURRENT_DATE' AND note = 'UNIX_TIMESTAMP('";
    const { sql, applied } = applyMysqlCompatRewrites(input);
    expect(sql).toBe(input);
    expect(applied).toEqual([]);
  });

  test('a column or alias named current_date is not clobbered', () => {
    // Qualified and quoted references must survive untouched.
    const input = 'SELECT t.current_date, "current_date" FROM t';
    const { sql } = applyMysqlCompatRewrites(input);
    expect(sql).toBe(input);
  });

  test('rewrites both code around a literal and report every rule applied', () => {
    const { sql, applied } = applyMysqlCompatRewrites(
      "SELECT UNIX_TIMESTAMP(a) FROM t WHERE b = 'x' AND c >= CURRENT_DATE"
    );
    expect(sql).toContain('toUnixTimestamp(a)');
    expect(sql).toContain('CURRENT_DATE()');
    expect(sql).toContain("'x'");
    expect(applied).toHaveLength(2);
  });

  test('queries with none of these constructs pass through byte-identical', () => {
    const input = 'SELECT DATE_ADD(now(), INTERVAL 1 DAY), IFNULL(x, 0), GROUP_CONCAT(y) FROM t GROUP BY z';
    const { sql, applied } = applyMysqlCompatRewrites(input);
    expect(sql).toBe(input);
    expect(applied).toEqual([]);
  });
});
