import { describe, expect, test } from 'vitest';
import { applyMysqlCompat, detectUnsupported } from '../mysqlCompat';

/**
 * Unit coverage for the MySQL compatibility rewriter.
 *
 * The differential suite (mysqlCompatDifferential.test.ts) proves the mappings
 * produce the same VALUES as MySQL, but it needs Docker and two databases.
 * These tests run everywhere and cover the parsing edges that decide whether a
 * rewrite fires at all: string literals, nesting, arity, identifiers that look
 * like function names, and idempotence.
 *
 * The governing rule for every case here: rewriting must be a strict widening.
 * A query that already worked must come out unchanged.
 */

const rw = (sql: string) => applyMysqlCompat(sql).sql;
const applied = (sql: string) => applyMysqlCompat(sql).applied;

describe('bare keyword forms', () => {
  test('CURRENT_DATE / CURRENT_TIMESTAMP gain parentheses', () => {
    expect(rw('SELECT CURRENT_DATE')).toBe('SELECT CURRENT_DATE()');
    expect(rw('SELECT CURRENT_TIMESTAMP')).toBe('SELECT CURRENT_TIMESTAMP()');
  });

  test('already-called forms are untouched', () => {
    expect(rw('SELECT CURRENT_DATE()')).toBe('SELECT CURRENT_DATE()');
    expect(rw('SELECT CURRENT_TIMESTAMP()')).toBe('SELECT CURRENT_TIMESTAMP()');
    expect(applied('SELECT CURRENT_DATE()')).toEqual([]);
  });

  test('case-insensitive input is matched (output is normalised to uppercase)', () => {
    const out = rw('SELECT * FROM t WHERE d >= current_date - INTERVAL 7 DAY');
    expect(out).toContain('CURRENT_DATE()');
    expect(out).toContain('INTERVAL 7 DAY');
  });

  test('a column named current_date is not rewritten', () => {
    expect(rw('SELECT t.current_date FROM t')).toBe('SELECT t.current_date FROM t');
    expect(rw('SELECT "current_date" FROM t')).toBe('SELECT "current_date" FROM t');
    expect(rw('SELECT `current_date` FROM t')).toBe('SELECT `current_date` FROM t');
  });
});

describe('DATEDIFF', () => {
  test('two-argument MySQL form swaps operands', () => {
    expect(rw('SELECT DATEDIFF(a, b) FROM t')).toBe("SELECT dateDiff('day', b, a) FROM t");
  });

  test('three-argument ClickHouse form is left alone', () => {
    const sql = "SELECT dateDiff('day', a, b) FROM t";
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
  });

  test('literal date arguments are parsed explicitly (ClickHouse will not coerce)', () => {
    const out = rw("SELECT DATEDIFF('2026-02-01', createdAt) FROM t");
    expect(out).toContain('parseDateTimeBestEffort');
    expect(out).toContain("dateDiff('day', createdAt,");
  });

  test('nested inside another call', () => {
    expect(rw('SELECT SUM(DATEDIFF(a, b)) FROM t')).toBe("SELECT SUM(dateDiff('day', b, a)) FROM t");
  });

  test('two independent calls in one query are both rewritten', () => {
    const out = rw('SELECT DATEDIFF(a,b), DATEDIFF(c,d) FROM t');
    expect(out).toBe("SELECT dateDiff('day', b, a), dateDiff('day', d, c) FROM t");
  });
});

describe('CONVERT_TZ', () => {
  test('UTC to a named zone', () => {
    expect(rw("SELECT CONVERT_TZ(c,'UTC','Asia/Kolkata')")).toBe("SELECT toTimeZone(c, 'Asia/Kolkata')");
  });

  test('numeric offsets become an INTERVAL shift', () => {
    // ClickHouse has no zone for +05:30; converting from UTC to a fixed
    // offset is by definition adding that offset.
    expect(rw("SELECT CONVERT_TZ(c,'+00:00','+05:30')")).toBe('SELECT (c + INTERVAL 330 MINUTE)');
    expect(rw("SELECT CONVERT_TZ(c,'+00:00','-05:00')")).toBe('SELECT (c - INTERVAL 300 MINUTE)');
  });

  test('a zero offset is a no-op', () => {
    expect(rw("SELECT CONVERT_TZ(c,'UTC','+00:00')")).toBe('SELECT c');
  });

  test('a NON-UTC source zone is refused rather than silently shifted', () => {
    const sql = "SELECT CONVERT_TZ(c,'Asia/Kolkata','UTC')";
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
    // ...and it is reported as unsupported so the failure is explainable.
    expect(detectUnsupported(sql).join(' ')).toContain('CONVERT_TZ');
  });

  test('GMT and +00:00 both count as UTC sources', () => {
    expect(rw("SELECT CONVERT_TZ(c,'GMT','Asia/Kolkata')")).toContain('toTimeZone');
    expect(rw("SELECT CONVERT_TZ(c,'+00:00','Asia/Kolkata')")).toContain('toTimeZone');
  });
});

describe('WEEKDAY / DAYNAME', () => {
  test('WEEKDAY is shifted to MySQL numbering', () => {
    expect(rw('SELECT WEEKDAY(c) FROM t')).toBe('SELECT (toDayOfWeek(c) - 1) FROM t');
  });

  test('DAYNAME maps to dateName', () => {
    expect(rw('SELECT DAYNAME(c) FROM t')).toBe("SELECT dateName('weekday', c) FROM t");
  });

  test('wrong arity is left alone rather than mangled', () => {
    const sql = 'SELECT WEEKDAY(a, b) FROM t';
    expect(rw(sql)).toBe(sql);
  });
});

describe('FIELD', () => {
  test('maps to indexOf preserving argument order', () => {
    expect(rw("SELECT FIELD(status,'a','b') FROM t"))
      .toBe("SELECT indexOf(['a', 'b'], status) FROM t");
  });

  test('works in ORDER BY, the common usage', () => {
    expect(rw("SELECT id FROM t ORDER BY FIELD(status,'x','y'), id"))
      .toBe("SELECT id FROM t ORDER BY indexOf(['x', 'y'], status), id");
  });

  test('a single argument is not a FIELD call we can map', () => {
    expect(rw('SELECT FIELD(x) FROM t')).toBe('SELECT FIELD(x) FROM t');
  });
});

describe('GROUP_CONCAT', () => {
  test('SEPARATOR form maps to arrayStringConcat', () => {
    expect(rw("SELECT GROUP_CONCAT(name SEPARATOR '|') FROM t"))
      .toBe("SELECT arrayStringConcat(groupArray(name), '|') FROM t");
  });

  test('plain form is left to ClickHouse, which supports it', () => {
    const sql = 'SELECT GROUP_CONCAT(name) FROM t';
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
  });

  test('separator containing a comma is not split as an argument', () => {
    expect(rw("SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM t"))
      .toBe("SELECT arrayStringConcat(groupArray(name), ', ') FROM t");
  });
});

describe('JSON', () => {
  test('JSON_UNQUOTE(JSON_EXTRACT(...)) maps to JSON_VALUE', () => {
    expect(rw("SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.tier')) FROM t"))
      .toBe("SELECT JSON_VALUE(payload, '$.tier') FROM t");
  });

  test('bare JSON_EXTRACT is deliberately NOT rewritten', () => {
    // It returns a JSON value (strings keep their quotes) whereas JSON_VALUE
    // returns a scalar — rewriting would change results.
    const sql = "SELECT JSON_EXTRACT(payload,'$.tier') FROM t";
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
  });

  test('JSON_UNQUOTE around something else is left alone', () => {
    const sql = 'SELECT JSON_UNQUOTE(col) FROM t';
    expect(rw(sql)).toBe(sql);
  });

  test('a JSON path containing SQL-like text is never rewritten', () => {
    const out = rw("SELECT JSON_UNQUOTE(JSON_EXTRACT(p,'$.CURRENT_DATE')) FROM t");
    expect(out).toContain("'$.CURRENT_DATE'");
    expect(out).not.toContain('CURRENT_DATE()');
  });
});

describe('CAST rounding', () => {
  test('UNSIGNED and SIGNED round like MySQL, not truncate', () => {
    expect(rw('SELECT CAST(amount AS UNSIGNED) FROM t'))
      .toBe('SELECT toUInt64(floor(toFloat64(amount) + 0.5)) FROM t');
    expect(rw('SELECT CAST(amount AS SIGNED) FROM t'))
      .toBe('SELECT toInt64(floor(toFloat64(amount) + 0.5)) FROM t');
  });

  test('SIGNED INTEGER spelling is handled', () => {
    expect(rw('SELECT CAST(x AS SIGNED INTEGER) FROM t')).toContain('toInt64');
  });

  test('other target types are untouched', () => {
    for (const sql of [
      'SELECT CAST(id AS CHAR) FROM t',
      'SELECT CAST(x AS DECIMAL(20,2)) FROM t',
      'SELECT CAST(x AS DATETIME) FROM t',
    ]) {
      expect(rw(sql)).toBe(sql);
    }
  });
});

describe('string literals are inviolable', () => {
  test('SQL-looking text inside a literal is never rewritten', () => {
    const sql = "SELECT * FROM t WHERE note = 'CURRENT_DATE and DATEDIFF(a,b) and CAST(x AS UNSIGNED)'";
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
  });

  test('code around a literal is still rewritten', () => {
    const out = rw("SELECT CURRENT_DATE, 'CURRENT_DATE' AS label FROM t");
    expect(out).toBe("SELECT CURRENT_DATE(), 'CURRENT_DATE' AS label FROM t");
  });

  test('escaped quotes inside literals do not break masking', () => {
    const sql = "SELECT 'it''s fine', CURRENT_DATE FROM t";
    expect(rw(sql)).toBe("SELECT 'it''s fine', CURRENT_DATE() FROM t");
  });
});

describe('robustness', () => {
  test('idempotent — rewriting twice equals rewriting once', () => {
    const queries = [
      'SELECT DATEDIFF(a,b) FROM t',
      "SELECT CONVERT_TZ(c,'UTC','Asia/Kolkata')",
      'SELECT WEEKDAY(c), CAST(x AS UNSIGNED) FROM t',
      "SELECT GROUP_CONCAT(n SEPARATOR '|') FROM t",
    ];
    for (const q of queries) {
      const once = rw(q);
      expect(rw(once), q).toBe(once);
    }
  });

  test('unbalanced parentheses do not corrupt the query', () => {
    const sql = 'SELECT DATEDIFF(a, b FROM t';
    expect(rw(sql)).toBe(sql);
  });

  test('a query needing nothing passes through byte-identical', () => {
    const sql =
      'SELECT id, COALESCE(a, 0), DATE_ADD(d, INTERVAL 1 DAY), IFNULL(x, y) ' +
      'FROM t WHERE z > 1 GROUP BY id HAVING COUNT(*) > 2 ORDER BY id LIMIT 10, 20';
    expect(rw(sql)).toBe(sql);
    expect(applied(sql)).toEqual([]);
  });

  test('multiple different rewrites in one query are all reported', () => {
    const list = applied(
      "SELECT DATEDIFF(a,b), WEEKDAY(c), CAST(x AS UNSIGNED), CONVERT_TZ(d,'UTC','Asia/Kolkata'), CURRENT_DATE FROM t",
    );
    expect(list.length).toBeGreaterThanOrEqual(5);
  });

  test('empty and whitespace input are handled', () => {
    expect(rw('')).toBe('');
    expect(rw('   ')).toBe('   ');
  });
});

describe('detectUnsupported', () => {
  test('flags constructs with no faithful translation', () => {
    const cases: Array<[string, string]> = [
      ["SELECT * FROM JSON_TABLE(p,'$[*]' COLUMNS(a INT PATH '$.a')) x", 'JSON_TABLE'],
      ['SELECT JSON_ARRAYAGG(x) FROM t', 'JSON_ARRAYAGG'],
      ['SELECT JSON_OBJECT(\'a\',1)', 'JSON_OBJECT'],
      ["SELECT JSON_CONTAINS(p,'1')", 'JSON_CONTAINS'],
      ['INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1', 'ON DUPLICATE KEY'],
      ['SELECT * FROM t FOR UPDATE', 'FOR UPDATE'],
    ];
    for (const [sql, expected] of cases) {
      expect(detectUnsupported(sql).join(' '), sql).toContain(expected);
    }
  });

  test('a clean query reports nothing', () => {
    expect(detectUnsupported('SELECT id FROM t WHERE a = 1')).toEqual([]);
  });
});
