import { describe, test, expect } from 'vitest';
import { routeQuery, type RouteResult, type InterceptedResult, type ForwardResult } from '../mysqlQueryRouter';

// Helper: default args for routeQuery
const route = (sql: string, opts?: { db?: string; databases?: string[] }): RouteResult =>
  routeQuery(sql, 1, opts?.db || 'mydb', 'testuser', opts?.databases || ['mydb', 'other']);

function expectIntercepted(r: RouteResult): InterceptedResult {
  expect(r.type).toBe('intercepted');
  return r as InterceptedResult;
}

function expectForward(r: RouteResult): ForwardResult {
  expect(r.type).toBe('forward');
  return r as ForwardResult;
}

function expectOk(r: RouteResult): void {
  expect(r.type).toBe('ok');
}

function expectError(r: RouteResult, code?: number): void {
  expect(r.type).toBe('error');
  if (code !== undefined && r.type === 'error') {
    expect(r.code).toBe(code);
  }
}

// =====================================================================
// Category A: Intercept & respond
// =====================================================================

describe('mysqlQueryRouter', () => {
  describe('SET statements', () => {
    test('SET NAMES utf8mb4 -> ok', () => expectOk(route('SET NAMES utf8mb4')));
    test('SET @var = 1 -> ok', () => expectOk(route('SET @var = 1')));
    test('SET SESSION wait_timeout = 600 -> ok', () => expectOk(route('SET SESSION wait_timeout = 600')));
  });

  describe('transaction control', () => {
    test('BEGIN -> ok', () => expectOk(route('BEGIN')));
    test('START TRANSACTION -> ok', () => expectOk(route('START TRANSACTION')));
    test('COMMIT -> ok', () => expectOk(route('COMMIT')));
    test('ROLLBACK -> ok', () => expectOk(route('ROLLBACK')));
  });

  describe('system variables', () => {
    test('SELECT @@version returns 8.0.32-Duckling', () => {
      const r = expectIntercepted(route('SELECT @@version'));
      expect(r.rows[0][0]).toBe('8.0.32-Duckling');
    });

    test('SELECT @@version_comment', () => {
      const r = expectIntercepted(route('SELECT @@version_comment'));
      expect(r.rows[0][0]).toBe('Duckling ClickHouse Server');
    });

    test('SELECT @@max_allowed_packet', () => {
      const r = expectIntercepted(route('SELECT @@max_allowed_packet'));
      expect(r.rows[0][0]).toBe('67108864');
    });

    test('SELECT @@global.read_only returns 1', () => {
      const r = expectIntercepted(route('SELECT @@global.read_only'));
      expect(r.rows[0][0]).toBe('1');
    });

    test('SELECT @@character_set_client returns utf8mb4', () => {
      const r = expectIntercepted(route('SELECT @@character_set_client'));
      expect(r.rows[0][0]).toBe('utf8mb4');
    });

    test('aliased variable: SELECT @@version AS v', () => {
      const r = expectIntercepted(route('SELECT @@version AS v'));
      // normalise() collapses whitespace but preserves casing in the alias
      // interceptSystemVariable extracts the alias from the uppercased expr
      expect(r.columns[0].name.toLowerCase()).toBe('v');
      expect(r.rows[0][0]).toBe('8.0.32-Duckling');
    });

    test('unknown variable returns NULL', () => {
      const r = expectIntercepted(route('SELECT @@nonexistent_var'));
      expect(r.rows[0][0]).toBeNull();
    });

    test('multi-variable: SELECT @@version_comment, @@max_allowed_packet', () => {
      const r = expectIntercepted(route('SELECT @@version_comment, @@max_allowed_packet'));
      expect(r.columns).toHaveLength(2);
      expect(r.rows[0][0]).toBe('Duckling ClickHouse Server');
      expect(r.rows[0][1]).toBe('67108864');
    });

    test('multi-variable with LIMIT', () => {
      const r = expectIntercepted(route('SELECT @@version_comment, @@max_allowed_packet LIMIT 1'));
      expect(r.columns).toHaveLength(2);
    });
  });

  describe('function calls', () => {
    test('SELECT VERSION()', () => {
      const r = expectIntercepted(route('SELECT VERSION()'));
      expect(r.rows[0][0]).toBe('8.0.32-Duckling');
    });

    test('SELECT DATABASE()', () => {
      const r = expectIntercepted(route('SELECT DATABASE()'));
      expect(r.rows[0][0]).toBe('mydb');
    });

    test('SELECT SCHEMA()', () => {
      const r = expectIntercepted(route('SELECT SCHEMA()'));
      expect(r.rows[0][0]).toBe('mydb');
    });

    test('SELECT CURRENT_USER()', () => {
      const r = expectIntercepted(route('SELECT CURRENT_USER()'));
      expect(r.rows[0][0]).toBe('testuser@%');
    });

    test('SELECT USER()', () => {
      const r = expectIntercepted(route('SELECT USER()'));
      expect(r.rows[0][0]).toBe('testuser@localhost');
    });

    test('SELECT CONNECTION_ID()', () => {
      const r = expectIntercepted(route('SELECT CONNECTION_ID()'));
      expect(r.rows[0][0]).toBe('1');
    });
  });

  describe('SHOW commands', () => {
    test('SHOW GRANTS', () => {
      const r = expectIntercepted(route('SHOW GRANTS'));
      expect(r.rows[0][0]).toContain('GRANT ALL');
    });

    test('SHOW WARNINGS -> empty', () => {
      const r = expectIntercepted(route('SHOW WARNINGS'));
      expect(r.rows).toHaveLength(0);
      expect(r.columns).toHaveLength(3);
    });

    test('SHOW ERRORS -> empty', () => {
      const r = expectIntercepted(route('SHOW ERRORS'));
      expect(r.rows).toHaveLength(0);
    });

    test('SHOW COLLATION', () => {
      const r = expectIntercepted(route('SHOW COLLATION'));
      expect(r.rows[0][0]).toBe('utf8mb4_general_ci');
    });

    test('SHOW VARIABLES -> empty', () => {
      const r = expectIntercepted(route('SHOW VARIABLES'));
      expect(r.rows).toHaveLength(0);
    });

    test('SHOW SESSION VARIABLES -> empty', () => {
      const r = expectIntercepted(route('SHOW SESSION VARIABLES'));
      expect(r.rows).toHaveLength(0);
    });

    test('SHOW STATUS -> empty', () => {
      const r = expectIntercepted(route('SHOW STATUS'));
      expect(r.rows).toHaveLength(0);
    });

    test('SHOW PROCESSLIST', () => {
      const r = expectIntercepted(route('SHOW PROCESSLIST'));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0][1]).toBe('testuser');
      expect(r.rows[0][3]).toBe('mydb');
    });
  });

  // =====================================================================
  // SHOW DATABASES / SCHEMAS
  // =====================================================================

  describe('SHOW DATABASES', () => {
    test('lists all databases', () => {
      const r = expectIntercepted(route('SHOW DATABASES', { databases: ['alpha', 'beta', 'gamma'] }));
      const dbs = r.rows.map(row => row[0]);
      expect(dbs).toEqual(['alpha', 'beta', 'gamma']);
    });

    test('SHOW SCHEMAS is equivalent', () => {
      const r = expectIntercepted(route('SHOW SCHEMAS', { databases: ['x'] }));
      expect(r.rows[0][0]).toBe('x');
    });

    test('LIKE filter with %', () => {
      const r = expectIntercepted(route("SHOW DATABASES LIKE 'al%'", { databases: ['alpha', 'beta', 'algo'] }));
      const dbs = r.rows.map(row => row[0]);
      expect(dbs).toContain('alpha');
      expect(dbs).toContain('algo');
      expect(dbs).not.toContain('beta');
    });

    test('LIKE filter with _', () => {
      const r = expectIntercepted(route("SHOW DATABASES LIKE 'a_c'", { databases: ['abc', 'adc', 'abcd'] }));
      const dbs = r.rows.map(row => row[0]);
      expect(dbs).toEqual(['abc', 'adc']);
    });

    test('LIKE filter case insensitive', () => {
      const r = expectIntercepted(route("SHOW DATABASES LIKE 'MYDB'", { databases: ['mydb', 'other'] }));
      expect(r.rows).toHaveLength(1);
    });
  });

  // =====================================================================
  // SHOW TABLES
  // =====================================================================

  describe('SHOW TABLES', () => {
    test('forwards to system.tables', () => {
      const r = expectForward(route('SHOW TABLES'));
      expect(r.sql).toContain('system.tables');
      expect(r.sql).toContain('currentDatabase()');
    });

    test('SHOW FULL TABLES includes Table_type', () => {
      const r = expectForward(route('SHOW FULL TABLES'));
      expect(r.sql).toContain('Table_type');
    });
  });

  // =====================================================================
  // DESCRIBE / SHOW COLUMNS
  // =====================================================================

  describe('DESCRIBE / SHOW COLUMNS', () => {
    test('DESCRIBE users', () => {
      const r = expectForward(route('DESCRIBE users'));
      expect(r.sql).toContain("table = 'users'");
    });

    test('DESC users', () => {
      const r = expectForward(route('DESC users'));
      expect(r.sql).toContain("table = 'users'");
    });

    test('SHOW COLUMNS FROM users', () => {
      const r = expectForward(route('SHOW COLUMNS FROM users'));
      expect(r.sql).toContain("table = 'users'");
    });

    test('SHOW FIELDS FROM users', () => {
      const r = expectForward(route('SHOW FIELDS FROM users'));
      expect(r.sql).toContain("table = 'users'");
    });

    test('invalid table name returns error', () => {
      expectError(route('DESCRIBE "invalid; DROP TABLE"'), 1064);
    });
  });

  // =====================================================================
  // INFORMATION_SCHEMA
  // =====================================================================

  describe('INFORMATION_SCHEMA.SCHEMATA', () => {
    test('returns all databases', () => {
      const r = expectIntercepted(route(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA",
        { databases: ['db1', 'db2'] },
      ));
      const schemas = r.rows.map(row => row[0]);
      expect(schemas).toEqual(['db1', 'db2']);
    });

    test('SELECT * returns all columns', () => {
      const r = expectIntercepted(route(
        "SELECT * FROM INFORMATION_SCHEMA.SCHEMATA",
        { databases: ['mydb'] },
      ));
      expect(r.columns.map(c => c.name)).toEqual([
        'CATALOG_NAME', 'SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME',
        'DEFAULT_COLLATION_NAME', 'SQL_PATH', 'DEFAULT_ENCRYPTION',
      ]);
      expect(r.rows[0][0]).toBe('def');
      expect(r.rows[0][1]).toBe('mydb');
      expect(r.rows[0][2]).toBe('utf8mb4');
    });

    test('aliased columns preserve alias', () => {
      const r = expectIntercepted(route(
        "SELECT SCHEMA_NAME AS DatabaseName FROM INFORMATION_SCHEMA.SCHEMATA",
        { databases: ['testdb'] },
      ));
      expect(r.columns[0].name).toBe('DatabaseName');
      expect(r.rows[0][0]).toBe('testdb');
    });

    test('works with backtick-quoted identifiers', () => {
      const r = expectIntercepted(route(
        "SELECT `SCHEMA_NAME` FROM `INFORMATION_SCHEMA`.`SCHEMATA`",
        { databases: ['mydb'] },
      ));
      expect(r.rows[0][0]).toBe('mydb');
    });
  });

  describe('INFORMATION_SCHEMA.ROUTINES', () => {
    test('returns empty projected result', () => {
      const r = expectIntercepted(route(
        "SELECT ROUTINE_SCHEMA as fn_schema, ROUTINE_NAME as fn_name FROM information_schema.routines WHERE ROUTINE_SCHEMA='mydb'",
      ));
      expect(r.rows).toHaveLength(0);
      expect(r.columns.map(c => c.name)).toEqual(['fn_schema', 'fn_name']);
    });
  });

  describe('INFORMATION_SCHEMA.STATISTICS', () => {
    test('primary key query forwards to ClickHouse system.columns', () => {
      const r = expectForward(route(
        "SELECT column_name as column_name FROM information_schema.statistics " +
        "WHERE table_schema = 'mydb' AND table_name = 'users' AND index_name = 'PRIMARY'",
      ));
      expect(r.sql).toContain('system.columns');
      expect(r.sql).toContain("table = 'users'");
      expect(r.sql).toContain('is_in_primary_key = 1');
    });

    test('non-primary index returns empty', () => {
      const r = expectIntercepted(route(
        "SELECT column_name FROM information_schema.statistics " +
        "WHERE table_name = 'users' AND index_name = 'idx_email'",
      ));
      expect(r.rows).toHaveLength(0);
    });

    test('sanitizes table name (rejects unsafe identifiers)', () => {
      const r = route(
        "SELECT column_name FROM information_schema.statistics " +
        "WHERE table_name = 'users; DROP TABLE x' AND index_name = 'PRIMARY'",
      );
      // sanitiseIdent returns null for unsafe names, so it falls through to empty result
      expect(r.type).toBe('intercepted');
      if (r.type === 'intercepted') {
        expect(r.rows).toHaveLength(0);
      }
    });
  });

  describe('INFORMATION_SCHEMA.COLUMNS', () => {
    test('rewrites column_type to data_type', () => {
      const r = expectForward(route(
        "SELECT column_type FROM information_schema.columns WHERE table_schema='mydb' AND table_name='users'",
      ));
      expect(r.sql).toContain('system.columns');
      expect(r.sql).toContain('column_type');
    });

    test('replaces character_set_name AS alias with empty string', () => {
      const r = expectForward(route(
        "SELECT character_set_name AS charset FROM information_schema.columns WHERE table_schema='mydb'",
      ));
      expect(r.sql).toContain("'' AS character_set_name");
    });

    test('replaces column_comment AS alias with empty string', () => {
      const r = expectForward(route(
        "SELECT column_comment AS comment FROM information_schema.columns WHERE table_schema='mydb'",
      ));
      expect(r.sql).toContain("'' AS column_comment");
    });

    test('replaces extra AS alias with empty string', () => {
      const r = expectForward(route(
        "SELECT extra AS extra_info FROM information_schema.columns WHERE table_schema='mydb'",
      ));
      expect(r.sql).toContain("'' AS extra");
    });

    test('rewrites TABLE_SCHEMA to main', () => {
      const r = expectForward(route(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='mydb'",
      ));
      expect(r.sql).toContain('database = currentDatabase()');
    });
  });

  describe('INFORMATION_SCHEMA.TABLES', () => {
    test('TABLE_ROWS with table_name forwards COUNT(*)', () => {
      const r = expectForward(route(
        "SELECT table_rows as count FROM information_schema.TABLES WHERE TABLE_SCHEMA='mydb' AND TABLE_NAME='users'",
      ));
      expect(r.sql).toContain('COUNT(*)');
      expect(r.sql).toContain('"users"');
    });

    test('TABLE_ROWS without table_name returns 0', () => {
      const r = expectIntercepted(route(
        "SELECT table_rows as count FROM information_schema.TABLES WHERE TABLE_SCHEMA='mydb'",
      ));
      expect(r.rows[0][0]).toBe('0');
    });

    test('TABLE_ROWS sanitizes table name', () => {
      const r = route(
        "SELECT table_rows FROM information_schema.TABLES WHERE TABLE_NAME='x; DROP TABLE y'",
      );
      // sanitiseIdent rejects unsafe names -> falls through to intercepted '0'
      expect(r.type).toBe('intercepted');
    });

    test('DATA_LENGTH/INDEX_LENGTH returns zeros', () => {
      const r = expectIntercepted(route(
        "SELECT data_length AS ds, index_length AS is_, table_comment AS cmt FROM information_schema.TABLES WHERE table_schema='mydb' AND table_name='users'",
      ));
      expect(r.columns.map(c => c.name)).toEqual(['ds', 'is_', 'cmt']);
      expect(r.rows[0][0]).toBe('0');
      expect(r.rows[0][1]).toBe('0');
      expect(r.rows[0][2]).toBe('');
    });

    test('expression with parentheses: (data_length + index_length) AS total', () => {
      const r = expectIntercepted(route(
        "SELECT data_length AS ds, index_length AS idx, (data_length + index_length) AS total FROM information_schema.TABLES WHERE table_schema='mydb'",
      ));
      // splitSelectExpressions should keep (data_length + index_length) together
      expect(r.columns).toHaveLength(3);
      expect(r.columns[2].name).toBe('total');
    });
  });

  // =====================================================================
  // Write operations -> error
  // =====================================================================

  describe('write operations', () => {
    test('INSERT -> error 1290', () => expectError(route("INSERT INTO users VALUES (1, 'a')"), 1290));
    test('UPDATE -> error 1290', () => expectError(route("UPDATE users SET name='b'"), 1290));
    test('DELETE -> error 1290', () => expectError(route('DELETE FROM users'), 1290));
    test('DROP -> error 1290', () => expectError(route('DROP TABLE users'), 1290));
    test('ALTER -> error 1290', () => expectError(route('ALTER TABLE users ADD col INT'), 1290));
    test('TRUNCATE -> error 1290', () => expectError(route('TRUNCATE TABLE users'), 1290));
    test('CREATE -> error 1290', () => expectError(route('CREATE TABLE t (id INT)'), 1290));
    test('REPLACE -> error 1290', () => expectError(route("REPLACE INTO users VALUES (1, 'a')"), 1290));
    test('RENAME -> error 1290', () => expectError(route('RENAME TABLE users TO users2'), 1290));
  });

  // =====================================================================
  // SQL rewriting (backticks, db qualifiers)
  // =====================================================================

  describe('ClickHouse SQL rewriting', () => {
    test('backticks converted to double quotes for forwarded queries', () => {
      const r = expectForward(route('SELECT * FROM `users`'));
      expect(r.sql).toContain('"users"');
      expect(r.sql).not.toContain('`');
    });

    test('db-qualified table: `mydb`.`users` -> "users"', () => {
      const r = expectForward(route('SELECT * FROM `mydb`.`users`'));
      expect(r.sql).toContain('"users"');
      expect(r.sql).not.toContain('"mydb"');
    });

    test('unquoted db-qualified table: mydb.users -> users', () => {
      const r = expectForward(route('SELECT * FROM mydb.users'));
      expect(r.sql).not.toMatch(/\bmydb\./);
    });

    test('TABLE_SCHEMA rewritten to main', () => {
      const r = expectForward(route("SELECT * FROM t WHERE TABLE_SCHEMA = 'mydb'"));
      expect(r.sql).toContain("TABLE_SCHEMA = 'main'");
    });

    test('EXPLAIN query is also rewritten', () => {
      const r = expectForward(route('EXPLAIN SELECT * FROM `mydb`.`users`'));
      expect(r.sql).toContain('"users"');
      expect(r.sql).not.toContain('`');
    });
  });

  // =====================================================================
  // SHOW TABLE STATUS / SHOW CREATE TABLE / SHOW INDEX
  // =====================================================================

  describe('SHOW TABLE STATUS', () => {
    test('forwards to system.tables', () => {
      const r = expectForward(route('SHOW TABLE STATUS'));
      expect(r.sql).toContain('system.tables');
    });
  });

  describe('SHOW CREATE TABLE', () => {
    test('forwards column info query', () => {
      const r = expectForward(route('SHOW CREATE TABLE users'));
      expect(r.sql).toContain("table = 'users'");
    });
  });

  describe('SHOW INDEX', () => {
    test('SHOW INDEX FROM users -> empty', () => {
      const r = expectIntercepted(route('SHOW INDEX FROM users'));
      expect(r.rows).toHaveLength(0);
    });

    test('SHOW KEYS FROM users -> empty', () => {
      const r = expectIntercepted(route('SHOW KEYS FROM users'));
      expect(r.rows).toHaveLength(0);
    });
  });

  // =====================================================================
  // Misc
  // =====================================================================

  describe('misc commands', () => {
    test('KILL -> ok', () => expectOk(route('KILL 42')));
    test('USE db -> ok', () => expectOk(route('USE mydb')));
  });

  describe('plain SELECT forwarding', () => {
    test('SELECT * FROM users -> forward', () => {
      const r = expectForward(route('SELECT * FROM users'));
      expect(r.sql).toContain('users');
    });

    test('trailing semicolons stripped', () => {
      const r = expectForward(route('SELECT 1;;;'));
      expect(r.sql).not.toContain(';');
    });

    test('whitespace normalized', () => {
      const r = expectForward(route('SELECT   *   FROM   users'));
      expect(r.sql).toBe('SELECT * FROM users');
    });
  });
});
