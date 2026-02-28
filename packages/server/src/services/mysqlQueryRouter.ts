/**
 * MySQL Query Router
 *
 * Routes incoming MySQL wire-protocol queries into three categories:
 *   A) Intercept — return a canned response (session vars, SET, SHOW GRANTS, …)
 *   B) Translate — rewrite MySQL-isms to DuckDB-compatible SQL
 *   C) Forward  — pass through to DuckDB as-is
 *
 * Read-only: INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE are rejected.
 */

import {
  singleValueResult,
  emptyResult,
  buildColumnDefinition,
  type MySQLColumnDefinition,
} from './mysqlResultFormatter';
import logger from '../logger';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface InterceptedResult {
  type: 'intercepted';
  columns: MySQLColumnDefinition[];
  rows: (string | null)[][];
}

export interface OkResult {
  type: 'ok';
}

export interface ForwardResult {
  type: 'forward';
  sql: string;
}

export interface ErrorResult {
  type: 'error';
  code: number;
  message: string;
}

export type RouteResult = InterceptedResult | OkResult | ForwardResult | ErrorResult;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Trim, collapse whitespace, strip trailing semicolons. */
function normalise(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').replace(/;+$/, '');
}

/** Case-insensitive test of the first N tokens. */
function startsWith(norm: string, ...tokens: string[]): boolean {
  const upper = norm.toUpperCase();
  return upper.startsWith(tokens.join(' '));
}

/** Extract the subject after SHOW … FROM <subject>. */
function extractFrom(norm: string): string | null {
  const m = norm.match(/FROM\s+[`"]?(\w+)[`"]?/i);
  return m ? m[1] : null;
}

/** Strip backticks and double-quotes from an identifier. */
function unquoteIdent(id: string): string {
  return id.replace(/^[`"']|[`"']$/g, '');
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

export function routeQuery(
  sql: string,
  connectionId: number,
  currentDatabase: string,
  currentUser: string,
  databases: string[],
): RouteResult {
  const norm = normalise(sql);
  const upper = norm.toUpperCase();

  // -------- Category A: Intercept & respond directly --------

  // SELECT @@variable / SELECT function()
  if (upper.startsWith('SELECT')) {
    const intercepted = tryInterceptSelect(norm, upper, connectionId, currentDatabase, currentUser);
    if (intercepted) return intercepted;
  }

  // SET (all variants) → OK
  if (upper.startsWith('SET ')) {
    return { type: 'ok' };
  }

  // Transaction control → OK (read-only, nothing to commit)
  if (
    upper === 'BEGIN' ||
    upper === 'START TRANSACTION' ||
    upper === 'COMMIT' ||
    upper === 'ROLLBACK'
  ) {
    return { type: 'ok' };
  }

  // SHOW GRANTS
  if (upper === 'SHOW GRANTS' || upper.startsWith('SHOW GRANTS ')) {
    const r = singleValueResult(
      `Grants for ${currentUser}@%`,
      `GRANT ALL PRIVILEGES ON *.* TO '${currentUser}'@'%'`,
    );
    return { type: 'intercepted', ...r };
  }

  // SHOW WARNINGS
  if (upper === 'SHOW WARNINGS') {
    const r = emptyResult(['Level', 'Code', 'Message']);
    return { type: 'intercepted', ...r };
  }

  // SHOW ERRORS
  if (upper === 'SHOW ERRORS') {
    const r = emptyResult(['Level', 'Code', 'Message']);
    return { type: 'intercepted', ...r };
  }

  // SHOW COLLATION
  if (upper.startsWith('SHOW COLLATION')) {
    const r = {
      columns: [
        buildColumnDefinition('Collation'),
        buildColumnDefinition('Charset'),
        buildColumnDefinition('Id', 'BIGINT'),
        buildColumnDefinition('Default'),
        buildColumnDefinition('Compiled'),
        buildColumnDefinition('Sortlen', 'BIGINT'),
      ],
      rows: [['utf8mb4_general_ci', 'utf8mb4', '45', 'Yes', 'Yes', '1']],
    };
    return { type: 'intercepted', ...r };
  }

  // SHOW VARIABLES — return a minimal set
  if (upper.startsWith('SHOW VARIABLES') || upper.startsWith('SHOW SESSION VARIABLES') || upper.startsWith('SHOW GLOBAL VARIABLES')) {
    const r = emptyResult(['Variable_name', 'Value']);
    return { type: 'intercepted', ...r };
  }

  // SHOW STATUS — return empty
  if (upper.startsWith('SHOW STATUS') || upper.startsWith('SHOW SESSION STATUS') || upper.startsWith('SHOW GLOBAL STATUS')) {
    const r = emptyResult(['Variable_name', 'Value']);
    return { type: 'intercepted', ...r };
  }

  // SHOW PROCESSLIST
  if (upper === 'SHOW PROCESSLIST' || upper === 'SHOW FULL PROCESSLIST') {
    const r = {
      columns: [
        buildColumnDefinition('Id', 'BIGINT'),
        buildColumnDefinition('User'),
        buildColumnDefinition('Host'),
        buildColumnDefinition('db'),
        buildColumnDefinition('Command'),
        buildColumnDefinition('Time', 'BIGINT'),
        buildColumnDefinition('State'),
        buildColumnDefinition('Info'),
      ],
      rows: [[String(connectionId), currentUser, 'localhost', currentDatabase, 'Query', '0', '', null]],
    };
    return { type: 'intercepted', ...r };
  }

  // -------- Write operations → error --------
  if (
    upper.startsWith('INSERT ') ||
    upper.startsWith('UPDATE ') ||
    upper.startsWith('DELETE ') ||
    upper.startsWith('REPLACE ') ||
    upper.startsWith('DROP ') ||
    upper.startsWith('ALTER ') ||
    upper.startsWith('TRUNCATE ') ||
    upper.startsWith('CREATE ') ||
    upper.startsWith('RENAME ')
  ) {
    return {
      type: 'error',
      code: 1290, // ER_OPTION_PREVENTS_STATEMENT
      message: 'This is a read-only DuckDB replica. Write operations must go through the source MySQL database.',
    };
  }

  // -------- Category B: Translate to DuckDB --------

  // SHOW DATABASES
  if (upper === 'SHOW DATABASES' || upper === 'SHOW SCHEMAS') {
    const r = {
      columns: [buildColumnDefinition('Database')],
      rows: databases.map(db => [db]),
    };
    return { type: 'intercepted', ...r };
  }

  // SHOW TABLES / SHOW FULL TABLES
  if (upper === 'SHOW TABLES' || upper.startsWith('SHOW TABLES FROM') || upper.startsWith('SHOW TABLES IN')) {
    return {
      type: 'forward',
      sql: `SELECT table_name AS "Tables_in_${currentDatabase}" FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    };
  }
  if (upper.startsWith('SHOW FULL TABLES')) {
    return {
      type: 'forward',
      sql: `SELECT table_name AS "Tables_in_${currentDatabase}", 'BASE TABLE' AS "Table_type" FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    };
  }

  // SHOW TABLE STATUS
  if (upper === 'SHOW TABLE STATUS' || upper.startsWith('SHOW TABLE STATUS FROM') || upper.startsWith('SHOW TABLE STATUS LIKE')) {
    return {
      type: 'forward',
      sql: `SELECT table_name AS "Name", 'DuckDB' AS "Engine", '10' AS "Version", 'Dynamic' AS "Row_format", 0 AS "Rows", 0 AS "Avg_row_length", 0 AS "Data_length", 0 AS "Max_data_length", 0 AS "Index_length", 0 AS "Data_free", NULL AS "Auto_increment", NULL AS "Create_time", NULL AS "Update_time", NULL AS "Check_time", 'utf8mb4_general_ci' AS "Collation", NULL AS "Checksum", '' AS "Create_options", '' AS "Comment" FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'`,
    };
  }

  // DESCRIBE / DESC / EXPLAIN <table> / SHOW COLUMNS FROM <table> / SHOW FIELDS FROM <table>
  if (upper.startsWith('DESCRIBE ') || upper.startsWith('DESC ') || upper.startsWith('SHOW COLUMNS FROM') || upper.startsWith('SHOW FIELDS FROM') || upper.startsWith('SHOW FULL COLUMNS FROM') || upper.startsWith('SHOW FULL FIELDS FROM')) {
    let tableName: string | null = null;
    if (upper.startsWith('DESCRIBE ') || upper.startsWith('DESC ')) {
      tableName = unquoteIdent(norm.split(/\s+/)[1]);
    } else {
      tableName = extractFrom(norm);
    }
    if (!tableName) {
      return { type: 'error', code: 1064, message: 'Could not parse table name' };
    }
    return {
      type: 'forward',
      sql: `SELECT column_name AS "Field", data_type AS "Type", CASE WHEN is_nullable = 'YES' THEN 'YES' ELSE 'NO' END AS "Null", '' AS "Key", column_default AS "Default", '' AS "Extra" FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'main' ORDER BY ordinal_position`,
    };
  }

  // SHOW CREATE TABLE
  if (upper.startsWith('SHOW CREATE TABLE')) {
    const tableName = extractFrom(norm) || unquoteIdent(norm.split(/\s+/).pop() || '');
    if (!tableName) {
      return { type: 'error', code: 1064, message: 'Could not parse table name' };
    }
    // We'll forward a query that returns column info; the protocol server will assemble the CREATE TABLE
    return {
      type: 'forward',
      sql: `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'main' ORDER BY ordinal_position`,
    };
  }

  // SHOW INDEX FROM <table>
  if (upper.startsWith('SHOW INDEX FROM') || upper.startsWith('SHOW INDEXES FROM') || upper.startsWith('SHOW KEYS FROM')) {
    const r = emptyResult([
      'Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name',
      'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null',
      'Index_type', 'Comment', 'Index_comment',
    ]);
    return { type: 'intercepted', ...r };
  }

  // KILL — ignore silently
  if (upper.startsWith('KILL ')) {
    return { type: 'ok' };
  }

  // USE <database> (handled at protocol level, but in case it arrives as a query)
  if (upper.startsWith('USE ')) {
    return { type: 'ok' };
  }

  // EXPLAIN <query> — forward with DuckDB's EXPLAIN
  if (upper.startsWith('EXPLAIN ')) {
    return { type: 'forward', sql: norm };
  }

  // -------- Category C: Forward to DuckDB --------
  return { type: 'forward', sql: norm };
}

/* ------------------------------------------------------------------ */
/*  SELECT interceptor                                                 */
/* ------------------------------------------------------------------ */

function tryInterceptSelect(
  norm: string,
  upper: string,
  connectionId: number,
  currentDatabase: string,
  currentUser: string,
): InterceptedResult | null {
  // Strip leading SELECT and optional whitespace
  const expr = upper.replace(/^SELECT\s+/i, '').trim();

  // @@variable patterns
  if (expr.startsWith('@@')) {
    return interceptSystemVariable(expr, connectionId, currentDatabase, currentUser);
  }

  // Function calls
  if (/^VERSION\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('VERSION()', '8.0.32-Duckling');
    return { type: 'intercepted', ...r };
  }
  if (/^DATABASE\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('DATABASE()', currentDatabase);
    return { type: 'intercepted', ...r };
  }
  if (/^SCHEMA\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('SCHEMA()', currentDatabase);
    return { type: 'intercepted', ...r };
  }
  if (/^CURRENT_USER\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('CURRENT_USER()', `${currentUser}@%`);
    return { type: 'intercepted', ...r };
  }
  if (/^USER\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('USER()', `${currentUser}@localhost`);
    return { type: 'intercepted', ...r };
  }
  if (/^CONNECTION_ID\s*\(\s*\)/i.test(expr)) {
    const r = singleValueResult('CONNECTION_ID()', String(connectionId), 'BIGINT');
    return { type: 'intercepted', ...r };
  }

  // Multi-expression SELECT with only @@vars (e.g. mysql client init)
  // Example: SELECT @@version_comment, @@max_allowed_packet
  if (expr.includes('@@') && !expr.includes('FROM')) {
    return interceptMultiVariable(norm, connectionId, currentDatabase, currentUser);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  System variable lookup                                             */
/* ------------------------------------------------------------------ */

const SYSTEM_VARS: Record<string, string> = {
  '@@VERSION': '8.0.32-Duckling',
  '@@VERSION_COMMENT': 'Duckling DuckDB Server',
  '@@GLOBAL.VERSION': '8.0.32-Duckling',
  '@@GLOBAL.VERSION_COMMENT': 'Duckling DuckDB Server',
  '@@MAX_ALLOWED_PACKET': '67108864',
  '@@GLOBAL.MAX_ALLOWED_PACKET': '67108864',
  '@@CHARACTER_SET_CLIENT': 'utf8mb4',
  '@@CHARACTER_SET_CONNECTION': 'utf8mb4',
  '@@CHARACTER_SET_RESULTS': 'utf8mb4',
  '@@CHARACTER_SET_SERVER': 'utf8mb4',
  '@@CHARACTER_SET_DATABASE': 'utf8mb4',
  '@@COLLATION_CONNECTION': 'utf8mb4_general_ci',
  '@@COLLATION_SERVER': 'utf8mb4_general_ci',
  '@@COLLATION_DATABASE': 'utf8mb4_general_ci',
  '@@SQL_MODE': '',
  '@@GLOBAL.SQL_MODE': '',
  '@@SESSION.SQL_MODE': '',
  '@@TRANSACTION_ISOLATION': 'REPEATABLE-READ',
  '@@SESSION.TRANSACTION_ISOLATION': 'REPEATABLE-READ',
  '@@GLOBAL.TRANSACTION_ISOLATION': 'REPEATABLE-READ',
  '@@TX_ISOLATION': 'REPEATABLE-READ',
  '@@SESSION.TX_ISOLATION': 'REPEATABLE-READ',
  '@@LOWER_CASE_TABLE_NAMES': '0',
  '@@AUTOCOMMIT': '1',
  '@@SESSION.AUTOCOMMIT': '1',
  '@@GLOBAL.AUTOCOMMIT': '1',
  '@@WAIT_TIMEOUT': '28800',
  '@@GLOBAL.WAIT_TIMEOUT': '28800',
  '@@INTERACTIVE_TIMEOUT': '28800',
  '@@NET_WRITE_TIMEOUT': '60',
  '@@NET_READ_TIMEOUT': '30',
  '@@SESSION.AUTO_INCREMENT_INCREMENT': '1',
  '@@AUTO_INCREMENT_INCREMENT': '1',
  '@@GLOBAL.READ_ONLY': '1',
  '@@SESSION.READ_ONLY': '1',
  '@@READ_ONLY': '1',
  '@@GLOBAL.SUPER_READ_ONLY': '1',
  '@@HAVE_SSL': 'DISABLED',
  '@@SSL_CA': '',
  '@@SSL_CERT': '',
  '@@SSL_KEY': '',
  '@@SYSTEM_TIME_ZONE': 'UTC',
  '@@TIME_ZONE': 'SYSTEM',
  '@@SESSION.TIME_ZONE': 'SYSTEM',
  '@@GLOBAL.TIME_ZONE': 'SYSTEM',
  '@@INIT_CONNECT': '',
  '@@GLOBAL.INIT_CONNECT': '',
  '@@PERFORMANCE_SCHEMA': '0',
  '@@GLOBAL.LOG_BIN': '0',
  '@@LOG_BIN': '0',
  '@@SESSION.TX_READ_ONLY': '1',
  '@@GLOBAL.TX_READ_ONLY': '1',
  '@@TX_READ_ONLY': '1',
  '@@GLOBAL.GTID_MODE': 'OFF',
  '@@GLOBAL.INNODB_READ_ONLY': '1',
  '@@GLOBAL.SERVER_ID': '1',
  '@@SERVER_ID': '1',
  '@@GLOBAL.HOSTNAME': 'duckling',
  '@@HOSTNAME': 'duckling',
  '@@PORT': '3307',
  '@@GLOBAL.PORT': '3307',
  '@@NET_BUFFER_LENGTH': '16384',
  '@@GLOBAL.NET_BUFFER_LENGTH': '16384',
};

function interceptSystemVariable(
  expr: string,
  connectionId: number,
  currentDatabase: string,
  _currentUser: string,
): InterceptedResult | null {
  // Handle aliased expressions: @@var AS alias
  const aliasMatch = expr.match(/^(@@[\w.]+)\s+AS\s+(.+)$/i);
  const varName = aliasMatch ? aliasMatch[1].toUpperCase() : expr.split(/[\s,]/)[0].toUpperCase();
  const alias = aliasMatch ? aliasMatch[2].trim() : expr.split(/[\s,]/)[0];

  // Dynamic variables
  if (varName === '@@CONNECTION_ID') {
    const r = singleValueResult(alias, String(connectionId), 'BIGINT');
    return { type: 'intercepted', ...r };
  }

  const value = SYSTEM_VARS[varName];
  if (value !== undefined) {
    const r = singleValueResult(alias, value);
    return { type: 'intercepted', ...r };
  }

  // Unknown variable — return NULL rather than erroring
  logger.debug(`Unknown system variable requested: ${varName}`);
  const r = singleValueResult(alias, null);
  return { type: 'intercepted', ...r };
}

/**
 * Handle SELECT with multiple @@variable expressions.
 * e.g. SELECT @@version_comment, @@max_allowed_packet LIMIT 1
 */
function interceptMultiVariable(
  norm: string,
  connectionId: number,
  currentDatabase: string,
  currentUser: string,
): InterceptedResult | null {
  // Strip SELECT … and optional LIMIT
  const body = norm.replace(/^SELECT\s+/i, '').replace(/\s+LIMIT\s+\d+$/i, '').trim();
  const parts = body.split(',').map(p => p.trim());

  const columns: MySQLColumnDefinition[] = [];
  const row: (string | null)[] = [];

  for (const part of parts) {
    const aliasMatch = part.match(/^(@@[\w.]+)\s+AS\s+(.+)$/i);
    const varExpr = aliasMatch ? aliasMatch[1].toUpperCase() : part.toUpperCase();
    const alias = aliasMatch ? aliasMatch[2].trim() : part;

    let value: string | null = null;
    if (varExpr === '@@CONNECTION_ID') {
      value = String(connectionId);
    } else {
      value = SYSTEM_VARS[varExpr] ?? null;
    }

    columns.push(buildColumnDefinition(alias));
    row.push(value);
  }

  return { type: 'intercepted', columns, rows: [row] };
}
