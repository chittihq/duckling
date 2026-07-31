import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execSync } from 'child_process';
import { applyMysqlCompat } from '../mysqlCompat';

/**
 * Differential tests: run the SAME query against MySQL and against ClickHouse
 * (after compatibility rewriting) and require identical results.
 *
 * "It executes without error" is a weak guarantee for a compatibility layer —
 * the dangerous failures are the silent ones. MySQL's DATEDIFF(a, b) computes
 * a - b while ClickHouse's dateDiff(unit, start, end) computes end - start, so
 * a mapping with the operands in the wrong order returns cleanly negated
 * numbers forever. Only comparing actual values catches that.
 *
 * Both engines are provisioned in Docker and seeded with identical data, so
 * this is an integration test, not a unit test: it is OPT-IN via
 * DUCKLING_DIFFERENTIAL=1 and skipped otherwise (and always when Docker is
 * unavailable). Keeping it out of the default run stops every `pnpm test`
 * from starting MySQL and ClickHouse.
 *
 *   DUCKLING_DIFFERENTIAL=1 pnpm --filter @chittihq/duckling-server test
 */

const MYSQL_C = 'duckling-compat-mysql';
const CH_C = 'duckling-compat-ch';
const DB = 'compat';
const MYSQL_PASS = 'compat-root';
const CH_PASS = 'compat-ch';

let DOCKER_OK = false;
try {
  execSync('docker info', { stdio: 'ignore', timeout: 20_000 });
  DOCKER_OK = true;
} catch {
  DOCKER_OK = false;
}

/**
 * Collapse SQL to a single line. JSON.stringify turns embedded newlines into
 * literal \n escapes, which the shell forwards verbatim and both engines
 * then reject as syntax errors.
 */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function sh(cmd: string, timeout = 60_000): string {
  return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run SQL on MySQL, tab-separated, no headers. */
function mysqlQuery(sql: string): string {
  const escaped = JSON.stringify(oneLine(sql));
  return sh(
    `docker exec ${MYSQL_C} mysql -uroot -p${MYSQL_PASS} ${DB} -N -B -e ${escaped} 2>/dev/null`,
  ).trim();
}

/** Run SQL on ClickHouse, tab-separated, no headers. */
function clickhouseQuery(sql: string): string {
  const escaped = JSON.stringify(oneLine(sql));
  return sh(
    `docker exec ${CH_C} clickhouse-client --password ${CH_PASS} -d ${DB} --format TabSeparated --query ${escaped}`,
  ).trim();
}

/**
 * Normalise cosmetic rendering differences that are not correctness issues:
 * trailing decimal zeros, NULL spelling, and line-ending noise.
 */
function normalize(out: string): string {
  return out
    .split('\n')
    .map(line =>
      line
        .split('\t')
        .map(cell => {
          const v = cell.trim();
          if (v === 'NULL' || v === '\\N' || v === '') return 'NULL';
          // 10.50 and 10.5 are the same number rendered differently.
          if (/^-?\d+\.\d+$/.test(v)) return String(parseFloat(v));
          return v;
        })
        .join('|'),
    )
    .join('\n');
}

function waitFor(fn: () => void, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fn();
      return true;
    } catch {
      execSync('sleep 2');
    }
  }
  return false;
}

const RUN_DIFFERENTIAL = DOCKER_OK && process.env.DUCKLING_DIFFERENTIAL === '1';

describe.skipIf(!RUN_DIFFERENTIAL)('MySQL vs ClickHouse differential results', () => {
  beforeAll(() => {
    sh(`docker rm -f ${MYSQL_C} ${CH_C} 2>/dev/null || true`);
    sh(
      `docker run -d --name ${MYSQL_C} -e MYSQL_ROOT_PASSWORD=${MYSQL_PASS} ` +
        `-e MYSQL_DATABASE=${DB} mysql:8.4`,
      180_000,
    );
    sh(`docker run -d --name ${CH_C} -e CLICKHOUSE_PASSWORD=${CH_PASS} clickhouse/clickhouse-server:25.8`, 180_000);

    const mysqlReady = waitFor(() => {
      sh(`docker exec ${MYSQL_C} mysql -uroot -p${MYSQL_PASS} -N -e "SELECT 1" ${DB} 2>/dev/null`, 15_000);
    }, 240_000);
    if (!mysqlReady) throw new Error('MySQL did not become ready');

    const chReady = waitFor(() => {
      sh(`docker exec ${CH_C} clickhouse-client --password ${CH_PASS} --query "SELECT 1"`, 15_000);
    }, 180_000);
    if (!chReady) throw new Error('ClickHouse did not become ready');

    // Identical data on both sides. UTC everywhere so timezone handling is
    // exercised deliberately rather than by accident.
    const rows = [
      "(1,'alpha','2026-01-05 10:30:00',10.50,'{\"tier\":\"gold\",\"n\":3}','active')",
      "(2,'beta','2026-01-10 23:15:00',20.00,'{\"tier\":\"silver\",\"n\":1}','active')",
      "(3,'gamma','2026-02-01 00:05:00',5.25,'{\"tier\":\"gold\",\"n\":7}','closed')",
      "(4,'delta','2026-02-14 18:45:00',0.00,'{\"tier\":\"bronze\",\"n\":0}','closed')",
    ].join(',');

    sh(
      `docker exec ${MYSQL_C} mysql -uroot -p${MYSQL_PASS} ${DB} -e ` +
        JSON.stringify(
          oneLine(`SET time_zone='+00:00';
           CREATE TABLE events (
             id INT PRIMARY KEY,
             name VARCHAR(64),
             createdAt DATETIME,
             amount DECIMAL(10,2),
             payload JSON,
             status VARCHAR(16)
           );
           INSERT INTO events VALUES ${rows};`),
        ) +
        ' 2>/dev/null',
    );

    sh(
      `docker exec ${CH_C} clickhouse-client --password ${CH_PASS} --query ` +
        JSON.stringify(`CREATE DATABASE IF NOT EXISTS ${DB}`),
    );

    sh(
      `docker exec ${CH_C} clickhouse-client --password ${CH_PASS} -d ${DB} --multiquery --query ` +
        JSON.stringify(
          oneLine(`CREATE TABLE events (
             id Int32,
             name String,
             createdAt DateTime('UTC'),
             amount Decimal(10,2),
             payload String,
             status String
           ) ENGINE=MergeTree ORDER BY id;
           INSERT INTO events VALUES ${rows};`),
        ),
    );
  }, 600_000);

  afterAll(() => {
    try {
      sh(`docker rm -f ${MYSQL_C} ${CH_C}`, 60_000);
    } catch {
      /* best effort */
    }
  });

  /**
   * Each case is written in MySQL dialect. It runs verbatim on MySQL, and
   * through applyMysqlCompat on ClickHouse. Results must match.
   */
  const cases: Array<[name: string, sql: string]> = [
    // --- the rewrites, checked for VALUE equality --------------------------
    ['DATEDIFF operand order', "SELECT id, DATEDIFF('2026-02-01', createdAt) AS d FROM events ORDER BY id"],
    ['DATEDIFF between columns', 'SELECT id, DATEDIFF(createdAt, createdAt) AS d FROM events ORDER BY id'],
    ['WEEKDAY numbering', 'SELECT id, WEEKDAY(createdAt) AS d FROM events ORDER BY id'],
    ['DAYNAME', 'SELECT id, DAYNAME(createdAt) AS d FROM events ORDER BY id'],
    ['MONTHNAME', 'SELECT id, MONTHNAME(createdAt) AS d FROM events ORDER BY id'],
    ['CONVERT_TZ to IST', "SELECT id, CONVERT_TZ(createdAt,'UTC','Asia/Kolkata') AS d FROM events ORDER BY id"],
    ['FIELD ordering', "SELECT id, FIELD(status,'closed','active') AS d FROM events ORDER BY id"],
    ['FIELD absent value', "SELECT id, FIELD(status,'zzz') AS d FROM events ORDER BY id"],
    ['GROUP_CONCAT with SEPARATOR', "SELECT status, GROUP_CONCAT(name SEPARATOR '|') AS d FROM events GROUP BY status ORDER BY status"],
    ['JSON_UNQUOTE(JSON_EXTRACT)', "SELECT id, JSON_UNQUOTE(JSON_EXTRACT(payload,'$.tier')) AS d FROM events ORDER BY id"],
    ['UNIX_TIMESTAMP', 'SELECT id, UNIX_TIMESTAMP(createdAt) AS d FROM events ORDER BY id'],

    // --- constructs that need NO rewrite, verified to agree anyway ---------
    ['DATE()', 'SELECT id, DATE(createdAt) AS d FROM events ORDER BY id'],
    ['DATE_FORMAT specifiers', "SELECT id, DATE_FORMAT(createdAt,'%Y-%m-%d') AS d FROM events ORDER BY id"],
    ['DATE_SUB with INTERVAL', 'SELECT id, DATE_SUB(createdAt, INTERVAL 7 DAY) AS d FROM events ORDER BY id'],
    ['TIMESTAMPDIFF', "SELECT id, TIMESTAMPDIFF(MINUTE, createdAt, '2026-03-01 00:00:00') AS d FROM events ORDER BY id"],
    ['YEAR/MONTH/HOUR', 'SELECT id, YEAR(createdAt), MONTH(createdAt), HOUR(createdAt) FROM events ORDER BY id'],
    ['IFNULL + NULLIF', 'SELECT id, IFNULL(NULLIF(amount,0), -1) AS d FROM events ORDER BY id'],
    ['CONCAT + SUBSTRING', "SELECT id, CONCAT(name,'-',status) AS d, SUBSTRING(name,1,3) AS s FROM events ORDER BY id"],
    ['COALESCE/GREATEST', 'SELECT id, GREATEST(amount, 6) AS d FROM events ORDER BY id'],
    ['aggregate + HAVING', 'SELECT status, COUNT(*) AS c, SUM(amount) AS s FROM events GROUP BY status HAVING COUNT(*) > 1 ORDER BY status'],
    ['LIMIT comma form', 'SELECT id FROM events ORDER BY id LIMIT 1, 2'],
    ['CAST AS UNSIGNED/CHAR', 'SELECT id, CAST(amount AS UNSIGNED) AS u, CAST(id AS CHAR) AS c FROM events ORDER BY id'],
    ['window function', 'SELECT id, ROW_NUMBER() OVER (PARTITION BY status ORDER BY id) AS rn FROM events ORDER BY id'],
    ['CTE', 'WITH a AS (SELECT status, COUNT(*) c FROM events GROUP BY status) SELECT * FROM a ORDER BY status'],
    ['LOCATE + TRIM', "SELECT id, LOCATE('a', name) AS l FROM events ORDER BY id"],
    ['SUBSTRING_INDEX', "SELECT SUBSTRING_INDEX('a.b.c','.',2) AS d"],
    ['CURDATE comparison', 'SELECT COUNT(*) FROM events WHERE createdAt < CURDATE()'],
    ['ORDER BY FIELD', "SELECT id FROM events ORDER BY FIELD(status,'closed','active'), id"],
  ];

  for (const [name, sql] of cases) {
    test(name, () => {
      const mysqlResult = normalize(mysqlQuery(sql));
      const { sql: chSql } = applyMysqlCompat(sql);
      const chResult = normalize(clickhouseQuery(chSql));
      expect(chResult, `MySQL: ${sql}\nClickHouse: ${chSql}`).toBe(mysqlResult);
    }, 60_000);
  }

  /**
   * A documented DIFFERENCE, asserted so it cannot regress silently into a
   * false sense of safety. MySQL's default collation (utf8mb4_general_ci) is
   * case-insensitive; ClickHouse compares bytes. No rewrite can reconcile
   * this without changing what the query means, so it is a caveat operators
   * must know about rather than something the layer papers over.
   */
  test('KNOWN DIFFERENCE: string equality is case-insensitive on MySQL only', () => {
    const sql = "SELECT COUNT(*) FROM events WHERE name = 'ALPHA'";
    const mysqlResult = normalize(mysqlQuery(sql));
    const chResult = normalize(clickhouseQuery(applyMysqlCompat(sql).sql));

    expect(mysqlResult).toBe('1'); // matches 'alpha' case-insensitively
    expect(chResult).toBe('0');    // byte comparison finds nothing
    expect(chResult).not.toBe(mysqlResult);
  }, 60_000);
});
