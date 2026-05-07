import { describe, test, expect } from 'vitest';
import mysql from 'mysql2/promise';
import {
  mysqlProtocolExecute,
  mysqlProtocolQuery,
  withMySQLProtocolConnection,
} from './helpers/mysqlProtocol.js';
import { API_KEY, DB_ID } from './helpers/config.js';

const PROTOCOL_HOST = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_HOST || '127.0.0.1';
const PROTOCOL_PORT = Number(process.env.DUCKLING_TEST_MYSQL_PROTOCOL_PORT || 3309);
const PROTOCOL_USER = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_USER || 'duckling';
const PROTOCOL_PASSWORD = process.env.DUCKLING_TEST_MYSQL_PROTOCOL_PASSWORD || API_KEY;

function pickValue(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return String(value);
  }
  return '';
}

// Helper: create a raw connection with custom credentials
async function connectWith(opts: {
  user?: string;
  password?: string;
  database?: string;
}): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: PROTOCOL_HOST,
    port: PROTOCOL_PORT,
    user: opts.user ?? PROTOCOL_USER,
    password: opts.password ?? PROTOCOL_PASSWORD,
    database: opts.database ?? DB_ID,
  });
}

// =====================================================================
// Original GUI-client compatibility tests
// =====================================================================

describe('Suite 10: MySQL Protocol Compatibility', () => {
  test('SHOW DATABASES includes configured database', async () => {
    const rows = await mysqlProtocolQuery('SHOW DATABASES');
    const dbs = rows.map(row => pickValue(row, 'Database', 'database', 'SCHEMA_NAME'));
    expect(dbs).toContain(DB_ID);
  });

  test('INFORMATION_SCHEMA.SCHEMATA returns Duckling database ids', async () => {
    const rows = await mysqlProtocolQuery(
      "SELECT SCHEMA_NAME AS DatabaseName FROM INFORMATION_SCHEMA.SCHEMATA " +
      "WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') " +
      'ORDER BY SCHEMA_NAME',
    );
    const dbs = rows.map(row => pickValue(row, 'DatabaseName', 'SCHEMA_NAME'));
    expect(dbs).toContain(DB_ID);
  });

  test('INFORMATION_SCHEMA.ROUTINES metadata query returns empty set, not error', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT ROUTINE_SCHEMA as function_schema,ROUTINE_NAME as function_name,` +
      `ROUTINE_DEFINITION as create_statement,ROUTINE_TYPE as function_type ` +
      `FROM information_schema.routines where ROUTINE_SCHEMA='${DB_ID}'`,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  test('INFORMATION_SCHEMA.TABLES size projection query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT data_length AS data_size, index_length AS index_size, ` +
      `(data_length + index_length) AS total_size, table_comment AS comment ` +
      `FROM information_schema.TABLES ` +
      `WHERE table_schema = '${DB_ID}' AND table_name = 'users_with_timestamps'`,
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(pickValue(row, 'data_size')).not.toBe('');
    expect(pickValue(row, 'index_size')).not.toBe('');
    expect(pickValue(row, 'total_size')).not.toBe('');
    expect(row).toHaveProperty('comment');
  });

  test('INFORMATION_SCHEMA.STATISTICS primary-key query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT column_name as column_name FROM information_schema.statistics ` +
      `WHERE table_schema = '${DB_ID}' AND table_name = 'users_with_timestamps' ` +
      `AND index_name = 'PRIMARY' ORDER BY seq_in_index ASC`,
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  test('INFORMATION_SCHEMA.COLUMNS enum projection query succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT table_name as table_name,column_name as column_name,column_type as column_type ` +
      `FROM information_schema.columns ` +
      `WHERE table_schema='${DB_ID}' AND table_name='users_with_timestamps' AND data_type='enum'`,
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  test('INFORMATION_SCHEMA.COLUMNS MySQL compatibility projection succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT ordinal_position as ordinal_position,column_name as column_name,column_type AS data_type,` +
      `character_set_name as character_set,collation_name as collation,is_nullable as is_nullable,` +
      `column_default as column_default,extra as extra,column_name AS foreign_key,column_comment AS comment ` +
      `FROM information_schema.columns WHERE table_schema='${DB_ID}' AND table_name='users_with_timestamps'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row).toHaveProperty('data_type');
    expect(row).toHaveProperty('character_set');
    expect(row).toHaveProperty('extra');
    expect(row).toHaveProperty('comment');
  });

  test('Backtick-qualified table queries succeed', async () => {
    const sampleRows = await mysqlProtocolQuery(
      `SELECT * FROM \`${DB_ID}\`.\`users_with_timestamps\` LIMIT 3 OFFSET 0`,
    );
    expect(sampleRows.length).toBeGreaterThan(0);

    const countRows = await mysqlProtocolQuery(
      `SELECT COUNT(*) as count FROM \`${DB_ID}\`.\`users_with_timestamps\``,
    );
    expect(pickValue(countRows[0], 'count', 'COUNT(*)')).toBe('5');
  });

  test('INFORMATION_SCHEMA.TABLES table_rows projection succeeds', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT table_rows as count FROM information_schema.TABLES ` +
      `WHERE TABLE_SCHEMA='${DB_ID}' AND TABLE_NAME='users_with_timestamps'`,
    );
    expect(rows.length).toBe(1);
    const count = Number(pickValue(rows[0], 'count'));
    expect(Number.isFinite(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Prepared statement path supports simple SET commands', async () => {
    await expect(
      mysqlProtocolExecute('SET NAMES utf8'),
    ).resolves.toEqual([]);
  });
});

// =====================================================================
// Authentication
// =====================================================================

describe('Suite 10a: Authentication', () => {
  test('wrong password is rejected', async () => {
    await expect(
      connectWith({ password: 'completely-wrong-password' }),
    ).rejects.toThrow(/Access denied/i);
  });

  test('wrong username is rejected', async () => {
    await expect(
      connectWith({ user: 'unknown_user' }),
    ).rejects.toThrow(/Access denied/i);
  });

  test('nonexistent database in connection is rejected', async () => {
    await expect(
      connectWith({ database: 'this_db_does_not_exist' }),
    ).rejects.toThrow(/Unknown database/i);
  });

  test('valid credentials connect successfully', async () => {
    const conn = await connectWith({});
    const [rows] = await conn.query('SELECT 1 AS ok');
    expect(Array.isArray(rows)).toBe(true);
    await conn.end();
  });
});

// =====================================================================
// Connection lifecycle
// =====================================================================

describe('Suite 10b: Connection Lifecycle', () => {
  test('COM_PING returns OK', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      // mysql2 exposes ping via the connection
      await conn.ping();
      // If we get here, ping succeeded (no throw)
    });
  });

  test('COM_QUIT closes gracefully', async () => {
    const conn = await connectWith({});
    await conn.query('SELECT 1');
    await conn.end(); // sends COM_QUIT
    // Verify connection is dead
    await expect(conn.query('SELECT 1')).rejects.toThrow();
  });

  test('multiple sequential connections succeed', async () => {
    for (let i = 0; i < 5; i++) {
      const conn = await connectWith({});
      const [rows] = await conn.query('SELECT 1 AS val');
      expect(Array.isArray(rows)).toBe(true);
      await conn.end();
    }
  });

  test('concurrent connections succeed', async () => {
    const connections = await Promise.all(
      Array.from({ length: 5 }, () => connectWith({})),
    );
    try {
      const results = await Promise.all(
        connections.map(async (conn, i) => {
          const [rows] = await conn.query(`SELECT ${i} AS idx`);
          return rows;
        }),
      );
      expect(results).toHaveLength(5);
      for (const rows of results) {
        expect(Array.isArray(rows)).toBe(true);
        expect((rows as any[]).length).toBe(1);
      }
    } finally {
      await Promise.all(connections.map(c => c.end().catch(() => {})));
    }
  });
});

// =====================================================================
// Read-only enforcement
// =====================================================================

describe('Suite 10c: Read-Only Enforcement', () => {
  const writeOps = [
    ['INSERT', `INSERT INTO users_with_timestamps (id, name) VALUES (999, 'hacker')`],
    ['UPDATE', `UPDATE users_with_timestamps SET name = 'hacked' WHERE id = 1`],
    ['DELETE', `DELETE FROM users_with_timestamps WHERE id = 1`],
    ['DROP', `DROP TABLE users_with_timestamps`],
    ['ALTER', `ALTER TABLE users_with_timestamps ADD COLUMN hacked INT`],
    ['TRUNCATE', `TRUNCATE TABLE users_with_timestamps`],
    ['CREATE', `CREATE TABLE hacker_table (id INT)`],
    ['REPLACE', `REPLACE INTO users_with_timestamps (id, name) VALUES (1, 'replaced')`],
    ['RENAME', `RENAME TABLE users_with_timestamps TO pwned`],
  ];

  test.each(writeOps)('%s is blocked with error', async (op, sql) => {
    await expect(mysqlProtocolQuery(sql)).rejects.toThrow(/read-only/i);
  });

  test('data is unchanged after all write attempts', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT COUNT(*) as count FROM \`${DB_ID}\`.\`users_with_timestamps\``,
    );
    expect(pickValue(rows[0], 'count', 'COUNT(*)')).toBe('5');
  });
});

// =====================================================================
// System variables via protocol
// =====================================================================

describe('Suite 10d: System Variables', () => {
  test('@@version returns Duckling version', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@version AS ver');
    expect(pickValue(rows[0], 'ver')).toBe('8.0.32-Duckling');
  });

  test('@@version_comment', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@version_comment AS vc');
    expect(pickValue(rows[0], 'vc')).toBe('Duckling ClickHouse Server');
  });

  test('@@character_set_client returns utf8mb4', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@character_set_client AS cs');
    expect(pickValue(rows[0], 'cs')).toBe('utf8mb4');
  });

  test('@@global.read_only returns 1', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@global.read_only AS ro');
    expect(pickValue(rows[0], 'ro')).toBe('1');
  });

  test('@@autocommit returns 1', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@autocommit AS ac');
    expect(pickValue(rows[0], 'ac')).toBe('1');
  });

  test('@@transaction_isolation returns REPEATABLE-READ', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@transaction_isolation AS ti');
    expect(pickValue(rows[0], 'ti')).toBe('REPEATABLE-READ');
  });

  test('@@sql_mode returns empty string', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@sql_mode AS sm');
    // empty string will be '' in the result
    const val = rows[0]['sm'];
    expect(val === '' || val === null).toBe(true);
  });

  test('@@have_ssl is DISABLED', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@have_ssl AS ssl');
    expect(pickValue(rows[0], 'ssl')).toBe('DISABLED');
  });

  test('unknown @@variable returns NULL', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@nonexistent_foobar AS x');
    expect(rows[0]['x']).toBeNull();
  });

  test('multi-variable SELECT works', async () => {
    const rows = await mysqlProtocolQuery(
      'SELECT @@version AS v, @@max_allowed_packet AS p, @@character_set_client AS cs',
    );
    expect(rows).toHaveLength(1);
    expect(pickValue(rows[0], 'v')).toBe('8.0.32-Duckling');
    expect(pickValue(rows[0], 'p')).toBe('67108864');
    expect(pickValue(rows[0], 'cs')).toBe('utf8mb4');
  });

  test('@@connection_id returns a numeric value', async () => {
    const rows = await mysqlProtocolQuery('SELECT @@connection_id AS cid');
    const cid = Number(pickValue(rows[0], 'cid'));
    expect(Number.isFinite(cid)).toBe(true);
    expect(cid).toBeGreaterThan(0);
  });
});

// =====================================================================
// Function calls via protocol
// =====================================================================

describe('Suite 10e: Function Calls', () => {
  test('SELECT VERSION()', async () => {
    const rows = await mysqlProtocolQuery('SELECT VERSION()');
    expect(pickValue(rows[0], 'VERSION()')).toBe('8.0.32-Duckling');
  });

  test('SELECT DATABASE()', async () => {
    const rows = await mysqlProtocolQuery('SELECT DATABASE()');
    expect(pickValue(rows[0], 'DATABASE()')).toBe(DB_ID);
  });

  test('SELECT CURRENT_USER()', async () => {
    const rows = await mysqlProtocolQuery('SELECT CURRENT_USER()');
    expect(pickValue(rows[0], 'CURRENT_USER()')).toContain(PROTOCOL_USER);
  });

  test('SELECT USER()', async () => {
    const rows = await mysqlProtocolQuery('SELECT USER()');
    expect(pickValue(rows[0], 'USER()')).toContain(PROTOCOL_USER);
  });

  test('SELECT CONNECTION_ID()', async () => {
    const rows = await mysqlProtocolQuery('SELECT CONNECTION_ID()');
    const cid = Number(pickValue(rows[0], 'CONNECTION_ID()'));
    expect(Number.isFinite(cid)).toBe(true);
    expect(cid).toBeGreaterThan(0);
  });
});

// =====================================================================
// SET / transaction stubs
// =====================================================================

describe('Suite 10f: SET and Transaction Stubs', () => {
  test('SET NAMES utf8mb4 returns OK', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      // SET should succeed without error (returns OkPacket, not rows)
      await conn.query('SET NAMES utf8mb4');
    });
  });

  test('SET CHARACTER SET utf8 returns OK', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      await conn.query('SET CHARACTER SET utf8');
    });
  });

  test('SET session variable returns OK', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      await conn.query('SET SESSION wait_timeout = 600');
    });
  });

  test('BEGIN / COMMIT / ROLLBACK accepted (no-op)', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      await conn.query('BEGIN');
      await conn.query('SELECT 1');
      await conn.query('COMMIT');
      await conn.query('BEGIN');
      await conn.query('ROLLBACK');
    });
  });

  test('START TRANSACTION accepted', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      await conn.query('START TRANSACTION');
      await conn.query('COMMIT');
    });
  });
});

// =====================================================================
// SHOW commands via protocol
// =====================================================================

describe('Suite 10g: SHOW Commands', () => {
  test('SHOW GRANTS returns grant info', async () => {
    const rows = await mysqlProtocolQuery('SHOW GRANTS');
    expect(rows).toHaveLength(1);
    const grantCol = Object.keys(rows[0]).find(k => k.startsWith('Grants for'));
    expect(grantCol).toBeDefined();
    expect(String(rows[0][grantCol!])).toContain('GRANT ALL');
  });

  test('SHOW WARNINGS returns empty', async () => {
    const rows = await mysqlProtocolQuery('SHOW WARNINGS');
    expect(rows).toHaveLength(0);
  });

  test('SHOW ERRORS returns empty', async () => {
    const rows = await mysqlProtocolQuery('SHOW ERRORS');
    expect(rows).toHaveLength(0);
  });

  test('SHOW COLLATION returns utf8mb4_general_ci', async () => {
    const rows = await mysqlProtocolQuery('SHOW COLLATION');
    expect(rows).toHaveLength(1);
    expect(pickValue(rows[0], 'Collation')).toBe('utf8mb4_general_ci');
  });

  test('SHOW VARIABLES returns empty result', async () => {
    const rows = await mysqlProtocolQuery('SHOW VARIABLES');
    expect(rows).toHaveLength(0);
  });

  test('SHOW STATUS returns empty result', async () => {
    const rows = await mysqlProtocolQuery('SHOW STATUS');
    expect(rows).toHaveLength(0);
  });

  test('SHOW PROCESSLIST returns current connection', async () => {
    const rows = await mysqlProtocolQuery('SHOW PROCESSLIST');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(pickValue(rows[0], 'User')).toBe(PROTOCOL_USER);
  });

  test('SHOW TABLES lists synced tables', async () => {
    const rows = await mysqlProtocolQuery('SHOW TABLES');
    const tableKey = Object.keys(rows[0] || {})[0];
    const tables = rows.map(r => String(r[tableKey]));
    expect(tables).toContain('users_with_timestamps');
  });

  test('SHOW FULL TABLES includes Table_type', async () => {
    const rows = await mysqlProtocolQuery('SHOW FULL TABLES');
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    const typeKey = Object.keys(row).find(k => k.toLowerCase().includes('type'));
    expect(typeKey).toBeDefined();
    expect(String(row[typeKey!])).toBe('BASE TABLE');
  });

  test('SHOW TABLE STATUS returns table info', async () => {
    const rows = await mysqlProtocolQuery('SHOW TABLE STATUS');
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(pickValue(row, 'Engine')).toBe('View');
  });

  test('SHOW INDEX FROM table returns empty', async () => {
    const rows = await mysqlProtocolQuery('SHOW INDEX FROM users_with_timestamps');
    expect(rows).toHaveLength(0);
  });

  test('SHOW CREATE TABLE returns column info', async () => {
    const rows = await mysqlProtocolQuery('SHOW CREATE TABLE users_with_timestamps');
    expect(rows.length).toBeGreaterThan(0);
  });

  test('DESCRIBE table returns column definitions', async () => {
    const rows = await mysqlProtocolQuery('DESCRIBE users_with_timestamps');
    expect(rows.length).toBeGreaterThan(0);
    const colNames = rows.map(r => pickValue(r, 'Field'));
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
  });

  test('SHOW DATABASES LIKE filters correctly', async () => {
    const rows = await mysqlProtocolQuery(`SHOW DATABASES LIKE '${DB_ID.charAt(0)}%'`);
    const dbs = rows.map(r => pickValue(r, 'Database'));
    expect(dbs).toContain(DB_ID);
  });
});

// =====================================================================
// Query execution & result formatting
// =====================================================================

describe('Suite 10h: Query Execution', () => {
  test('simple SELECT returns correct data', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT id, name FROM \`${DB_ID}\`.\`users_with_timestamps\` ORDER BY id LIMIT 2`,
    );
    expect(rows).toHaveLength(2);
    expect(pickValue(rows[0], 'name')).toBe('Alice');
    expect(pickValue(rows[1], 'name')).toBe('Bob');
  });

  test('aggregate queries work', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT COUNT(*) as cnt, MIN(id) as min_id, MAX(id) as max_id FROM \`${DB_ID}\`.\`users_with_timestamps\``,
    );
    expect(rows).toHaveLength(1);
    expect(pickValue(rows[0], 'cnt')).toBe('5');
    expect(pickValue(rows[0], 'min_id')).toBe('1');
    expect(pickValue(rows[0], 'max_id')).toBe('5');
  });

  test('WHERE clause filtering works', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT name FROM \`${DB_ID}\`.\`users_with_timestamps\` WHERE is_active = true ORDER BY name`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // Inactive users should not appear
    const names = rows.map(r => pickValue(r, 'name'));
    expect(names).not.toContain('Charlie'); // is_active = FALSE
  });

  test('NULL values returned correctly', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT name, bio FROM \`${DB_ID}\`.\`users_with_timestamps\` WHERE id = 4`,
    );
    expect(rows).toHaveLength(1);
    expect(pickValue(rows[0], 'name')).toBe('Diana');
    expect(rows[0]['bio']).toBeNull();
  });

  test('empty result set has zero rows', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT * FROM \`${DB_ID}\`.\`users_with_timestamps\` WHERE id = 99999`,
    );
    expect(rows).toHaveLength(0);
  });

  test('ORDER BY and LIMIT work', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT name FROM \`${DB_ID}\`.\`users_with_timestamps\` ORDER BY name DESC LIMIT 3`,
    );
    expect(rows).toHaveLength(3);
    const names = rows.map(r => pickValue(r, 'name'));
    // Descending alphabetical: Eve, Diana, Charlie (roughly)
    for (let i = 0; i < names.length - 1; i++) {
      expect(names[i] >= names[i + 1]).toBe(true);
    }
  });

  test('LIKE operator works in ClickHouse-backed queries', async () => {
    const rows = await mysqlProtocolQuery(
      `SELECT name FROM \`${DB_ID}\`.\`users_with_timestamps\` WHERE name LIKE 'A%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(pickValue(row, 'name').startsWith('A')).toBe(true);
    }
  });

  test('multiple tables queryable in same session', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      const [users] = await conn.query(
        `SELECT COUNT(*) as cnt FROM \`${DB_ID}\`.\`users_with_timestamps\``,
      );
      const [products] = await conn.query(
        `SELECT COUNT(*) as cnt FROM \`${DB_ID}\`.\`products_simple\``,
      );
      expect(Array.isArray(users)).toBe(true);
      expect(Array.isArray(products)).toBe(true);
      expect(Number((users as any[])[0].cnt)).toBeGreaterThan(0);
      expect(Number((products as any[])[0].cnt)).toBeGreaterThan(0);
    });
  });
});

// =====================================================================
// Error handling
// =====================================================================

describe('Suite 10i: Error Handling', () => {
  test('invalid SQL returns error', async () => {
    await expect(
      mysqlProtocolQuery('SELEKT * FORM nonexistent'),
    ).rejects.toThrow();
  });

  test('query on nonexistent table returns error', async () => {
    await expect(
      mysqlProtocolQuery('SELECT * FROM this_table_does_not_exist_xyz'),
    ).rejects.toThrow();
  });

  test('connection stays usable after query error', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      // First query fails
      await expect(
        conn.query('SELECT * FROM nonexistent_table_xyz'),
      ).rejects.toThrow();

      // Connection should still work
      const [rows] = await conn.query('SELECT 1 AS ok');
      expect(Array.isArray(rows)).toBe(true);
      expect((rows as any[])[0].ok).toBe(1);
    });
  });

  test('DESCRIBE nonexistent table returns error', async () => {
    await expect(
      mysqlProtocolQuery('DESCRIBE this_table_does_not_exist_xyz'),
    ).rejects.toThrow();
  });
});

// =====================================================================
// Multi-query session (sequential queries on same connection)
// =====================================================================

describe('Suite 10j: Multi-Query Session', () => {
  test('many sequential queries on same connection', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      // Run a mix of intercepted and forwarded queries
      await conn.query('SET NAMES utf8mb4');
      await conn.query('SELECT @@version');
      await conn.query('SELECT @@max_allowed_packet');
      await conn.query('SHOW DATABASES');
      await conn.query('SHOW TABLES');
      const [rows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM \`${DB_ID}\`.\`users_with_timestamps\``,
      );
      expect((rows as any[])[0].cnt).toBe(5);
      await conn.query('SHOW WARNINGS');
      await conn.query('SHOW COLLATION');
      await conn.query('SELECT 1');
    });
  });

  test('interleaved SET and SELECT on same connection', async () => {
    await withMySQLProtocolConnection(async (conn) => {
      for (let i = 0; i < 10; i++) {
        await conn.query('SET @x = 1');
        const [rows] = await conn.query(`SELECT ${i} AS val`);
        expect((rows as any[])[0].val).toBe(i);
      }
    });
  });
});
