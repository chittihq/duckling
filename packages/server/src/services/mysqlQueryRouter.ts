/**
 * MySQL Query Router
 *
 * Routes incoming MySQL wire-protocol queries into three categories:
 *   A) Intercept — return a canned response (session vars, SET, SHOW GRANTS, …)
 *   B) Translate — rewrite MySQL-isms to ClickHouse-compatible SQL
 *   C) Forward  — pass through to ClickHouse as-is
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

/** Extract the subject after SHOW … FROM <subject>. */
function extractFrom(norm: string): string | null {
  const m = norm.match(/FROM\s+[`"]?(\w+)[`"]?/i);
  return m ? m[1] : null;
}

/** Strip backticks and double-quotes from an identifier. */
function unquoteIdent(id: string): string {
  return id.replace(/^[`"']|[`"']$/g, '');
}

/**
 * Sanitise an identifier for safe interpolation into SQL strings.
 * Only allows alphanumeric characters and underscores.
 * Returns null if the input contains unsafe characters.
 */
function sanitiseIdent(id: string): string | null {
  const clean = unquoteIdent(id);
  if (!clean || !/^[A-Za-z_]\w{0,127}$/.test(clean)) return null;
  return clean;
}

/** Escape regex metacharacters. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert SQL LIKE pattern to JS RegExp (% => .*, _ => .). */
function likePatternToRegex(pattern: string): RegExp {
  let expr = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '%') {
      expr += '.*';
    } else if (ch === '_') {
      expr += '.';
    } else {
      expr += escapeRegex(ch);
    }
  }
  return new RegExp(`^${expr}$`, 'i');
}

/** Split comma-separated SELECT expressions, respecting quotes and parentheses. */
function splitSelectExpressions(selectClause: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '\'' | '`' | null = null;
  let parenDepth = 0;
  for (let i = 0; i < selectClause.length; i++) {
    const ch = selectClause[i];
    if ((ch === '"' || ch === '\'' || ch === '`') && parenDepth === 0) {
      if (quote === ch) {
        quote = null;
      } else if (!quote) {
        quote = ch as '"' | '\'' | '`';
      }
      current += ch;
      continue;
    }
    if (!quote) {
      if (ch === '(') { parenDepth++; current += ch; continue; }
      if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); current += ch; continue; }
    }
    if (ch === ',' && !quote && parenDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseColumnExpr(expr: string): { valueExpr: string; columnName: string } {
  const trimmed = expr.replace(/^DISTINCT\s+/i, '').trim();
  const asMatch = trimmed.match(/^(.*?)\s+AS\s+(.+)$/i);
  if (asMatch) {
    return { valueExpr: asMatch[1].trim(), columnName: unquoteIdent(asMatch[2].trim()) };
  }
  return { valueExpr: trimmed, columnName: unquoteIdent(trimmed) };
}

function extractWhereString(norm: string, key: string): string | null {
  const m = norm.match(new RegExp(`\\b${escapeRegex(key)}\\b\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return m ? m[2] : null;
}

function buildEmptyProjectedResult(norm: string): InterceptedResult {
  const selectMatch = norm.match(/^SELECT\s+(.+?)\s+FROM\s+/i);
  const selectClause = (selectMatch ? selectMatch[1] : '').trim();
  if (!selectClause) {
    const r = emptyResult(['result']);
    return { type: 'intercepted', ...r };
  }
  if (selectClause === '*') {
    const r = emptyResult([]);
    return { type: 'intercepted', ...r };
  }
  const expressions = splitSelectExpressions(selectClause);
  const columns = expressions.map(expr => buildColumnDefinition(parseColumnExpr(expr).columnName));
  return { type: 'intercepted', columns, rows: [] };
}

function rewriteForClickHouse(norm: string, currentDatabase: string): string {
  let rewritten = norm;

  // ClickHouse accepts double-quoted identifiers; MySQL clients send backticks.
  rewritten = rewritten.replace(/`([^`]+)`/g, '"$1"');

  // Drop MySQL db qualifier in table references, e.g. "lms"."Activity" -> "Activity".
  const currentDbEsc = escapeRegex(currentDatabase);
  rewritten = rewritten.replace(
    new RegExp(`"${currentDbEsc}"\\s*\\.\\s*"([^"]+)"`, 'gi'),
    '"$1"',
  );
  rewritten = rewritten.replace(
    new RegExp(`\\b${currentDbEsc}\\b\\s*\\.\\s*([A-Za-z_][\\w$]*)`, 'gi'),
    '$1',
  );

  // The compatibility layer uses ClickHouse's projected metadata tables.
  rewritten = rewritten.replace(/\bTABLE_SCHEMA\s*=\s*'[^']*'/ig, "TABLE_SCHEMA = 'main'");
  rewritten = rewritten.replace(/\bROUTINE_SCHEMA\s*=\s*'[^']*'/ig, "ROUTINE_SCHEMA = 'main'");

  return rewritten;
}

function resolveSchemataValue(valueExpr: string, databaseId: string): string | null {
  const normalized = valueExpr
    .trim()
    .replace(/[`"]/g, '')
    .replace(/^INFORMATION_SCHEMA\./i, '')
    .replace(/^SCHEMATA\./i, '')
    .toUpperCase();

  switch (normalized) {
    case '*':
      return null;
    case 'CATALOG_NAME':
      return 'def';
    case 'SCHEMA_NAME':
      return databaseId;
    case 'DEFAULT_CHARACTER_SET_NAME':
      return 'utf8mb4';
    case 'DEFAULT_COLLATION_NAME':
      return 'utf8mb4_general_ci';
    case 'SQL_PATH':
      return null;
    case 'DEFAULT_ENCRYPTION':
      return 'NO';
    default:
      return null;
  }
}

function buildSchemataResult(norm: string, databases: string[]): InterceptedResult {
  const sortedDatabases = [...databases].sort();
  const selectMatch = norm.match(/^SELECT\s+(.+?)\s+FROM\s+/i);
  const selectClause = (selectMatch ? selectMatch[1] : 'SCHEMA_NAME').trim();

  if (selectClause === '*') {
    const columns = [
      buildColumnDefinition('CATALOG_NAME'),
      buildColumnDefinition('SCHEMA_NAME'),
      buildColumnDefinition('DEFAULT_CHARACTER_SET_NAME'),
      buildColumnDefinition('DEFAULT_COLLATION_NAME'),
      buildColumnDefinition('SQL_PATH'),
      buildColumnDefinition('DEFAULT_ENCRYPTION'),
    ];
    const rows = sortedDatabases.map(db => [
      'def',
      db,
      'utf8mb4',
      'utf8mb4_general_ci',
      null,
      'NO',
    ]);
    return { type: 'intercepted', columns, rows };
  }

  const expressions = splitSelectExpressions(selectClause);
  const parsed = expressions.map(parseColumnExpr);
  const columns = parsed.map(expr => buildColumnDefinition(expr.columnName));
  const rows = sortedDatabases.map(db =>
    parsed.map(expr => resolveSchemataValue(expr.valueExpr, db)),
  );
  return { type: 'intercepted', columns, rows };
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

  // INFORMATION_SCHEMA.SCHEMATA introspection (used by some GUI clients)
  if (/FROM\s+[`"]?INFORMATION_SCHEMA[`"]?\.[`"]?SCHEMATA[`"]?/i.test(norm)) {
    return buildSchemataResult(norm, databases);
  }

  // INFORMATION_SCHEMA.ROUTINES does not exist in DuckDB; return an empty projected result.
  if (/FROM\s+[`"]?INFORMATION_SCHEMA[`"]?\.[`"]?ROUTINES[`"]?/i.test(norm)) {
    return buildEmptyProjectedResult(norm);
  }

  // INFORMATION_SCHEMA.STATISTICS emulation (primary-key columns only).
  if (/FROM\s+[`"]?INFORMATION_SCHEMA[`"]?\.[`"]?STATISTICS[`"]?/i.test(norm)) {
    const tableName = sanitiseIdent(extractWhereString(norm, 'table_name') || '');
    const indexName = extractWhereString(norm, 'index_name');
    if (
      tableName &&
      indexName &&
      indexName.toUpperCase() === 'PRIMARY' &&
      /\bCOLUMN_NAME\b/i.test(upper)
    ) {
      return {
        type: 'forward',
        sql:
          `SELECT kcu.column_name AS column_name ` +
          `FROM information_schema.table_constraints tc ` +
          `JOIN information_schema.key_column_usage kcu ` +
          `ON tc.constraint_name = kcu.constraint_name ` +
          `AND tc.table_schema = kcu.table_schema ` +
          `AND tc.table_name = kcu.table_name ` +
          `WHERE tc.constraint_type = 'PRIMARY KEY' ` +
          `AND kcu.table_schema = 'main' ` +
          `AND kcu.table_name = '${tableName}' ` +
          `ORDER BY kcu.ordinal_position`,
      };
    }
    return buildEmptyProjectedResult(norm);
  }

  // INFORMATION_SCHEMA.COLUMNS compatibility aliases expected by MySQL clients.
  if (/FROM\s+[`"]?INFORMATION_SCHEMA[`"]?\.[`"]?COLUMNS[`"]?/i.test(norm)) {
    let rewrittenColumnsSql = rewriteForClickHouse(norm, currentDatabase);
    rewrittenColumnsSql = rewrittenColumnsSql
      .replace(/\bcolumn_type\b/ig, 'data_type')
      .replace(/\bcharacter_set_name\s+AS\s+([`"]?\w+[`"]?)/ig, "'' AS $1")
      .replace(/\bcolumn_comment\s+AS\s+([`"]?\w+[`"]?)/ig, "'' AS $1")
      .replace(/\bextra\s+AS\s+([`"]?\w+[`"]?)/ig, "'' AS $1");
    return { type: 'forward', sql: rewrittenColumnsSql };
  }

  // INFORMATION_SCHEMA.TABLES compatibility columns expected by GUI clients.
  if (/FROM\s+[`"]?INFORMATION_SCHEMA[`"]?\.[`"]?TABLES[`"]?/i.test(norm)) {
    if (/\bTABLE_ROWS\b/i.test(upper)) {
      const tableName = sanitiseIdent(extractWhereString(norm, 'table_name') || '');
      if (tableName) {
        return { type: 'forward', sql: `SELECT COUNT(*) AS count FROM "${tableName}"` };
      }
      const r = singleValueResult('count', '0', 'BIGINT');
      return { type: 'intercepted', ...r };
    }
    if (/\bDATA_LENGTH\b/i.test(upper) || /\bINDEX_LENGTH\b/i.test(upper) || /\bTABLE_COMMENT\b/i.test(upper)) {
      const selectMatch = norm.match(/^SELECT\s+(.+?)\s+FROM\s+/i);
      const selectClause = (selectMatch ? selectMatch[1] : '').trim();
      const expressions = selectClause ? splitSelectExpressions(selectClause) : [];
      const parsed = expressions.map(parseColumnExpr);
      const columns = parsed.map(expr => buildColumnDefinition(expr.columnName));
      const row = parsed.map(expr => {
        const valueExpr = expr.valueExpr.toUpperCase();
        if (valueExpr.includes('DATA_LENGTH') || valueExpr.includes('INDEX_LENGTH')) return '0';
        if (valueExpr.includes('TABLE_COMMENT')) return '';
        return null;
      });
      return { type: 'intercepted', columns, rows: [row] };
    }
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
      message: 'This is a read-only ClickHouse replica. Write operations must go through the source MySQL database.',
    };
  }

  // -------- Category B: Translate to ClickHouse --------

  // SHOW DATABASES / SHOW SCHEMAS (+ LIKE filter)
  if (upper.startsWith('SHOW DATABASES') || upper.startsWith('SHOW SCHEMAS')) {
    const likeMatch = norm.match(/\bLIKE\s+(['"])(.*?)\1/i);
    const filteredDatabases = likeMatch
      ? databases.filter(db => likePatternToRegex(likeMatch[2]).test(db))
      : databases;
    const r = {
      columns: [buildColumnDefinition('Database')],
      rows: filteredDatabases.sort().map(db => [db]),
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
      sql: `SELECT table_name AS "Name", 'ClickHouse' AS "Engine", '10' AS "Version", 'Dynamic' AS "Row_format", 0 AS "Rows", 0 AS "Avg_row_length", 0 AS "Data_length", 0 AS "Max_data_length", 0 AS "Index_length", 0 AS "Data_free", NULL AS "Auto_increment", NULL AS "Create_time", NULL AS "Update_time", NULL AS "Check_time", 'utf8mb4_general_ci' AS "Collation", NULL AS "Checksum", '' AS "Create_options", '' AS "Comment" FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'`,
    };
  }

  // DESCRIBE / DESC / EXPLAIN <table> / SHOW COLUMNS FROM <table> / SHOW FIELDS FROM <table>
  if (upper.startsWith('DESCRIBE ') || upper.startsWith('DESC ') || upper.startsWith('SHOW COLUMNS FROM') || upper.startsWith('SHOW FIELDS FROM') || upper.startsWith('SHOW FULL COLUMNS FROM') || upper.startsWith('SHOW FULL FIELDS FROM')) {
    let rawName: string | null = null;
    if (upper.startsWith('DESCRIBE ') || upper.startsWith('DESC ')) {
      rawName = norm.split(/\s+/)[1] || null;
    } else {
      rawName = extractFrom(norm);
    }
    const tableName = rawName ? sanitiseIdent(rawName) : null;
    if (!tableName) {
      return { type: 'error', code: 1064, message: 'Invalid or missing table name' };
    }
    return {
      type: 'forward',
      sql: `SELECT column_name AS "Field", data_type AS "Type", CASE WHEN is_nullable = 'YES' THEN 'YES' ELSE 'NO' END AS "Null", '' AS "Key", column_default AS "Default", '' AS "Extra" FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'main' ORDER BY ordinal_position`,
    };
  }

  // SHOW CREATE TABLE
  if (upper.startsWith('SHOW CREATE TABLE')) {
    const rawName = extractFrom(norm) || (norm.split(/\s+/).pop() || '');
    const tableName = sanitiseIdent(rawName);
    if (!tableName) {
      return { type: 'error', code: 1064, message: 'Invalid or missing table name' };
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

  // EXPLAIN <query> — forward with ClickHouse's EXPLAIN
  if (upper.startsWith('EXPLAIN ')) {
    return { type: 'forward', sql: rewriteForClickHouse(norm, currentDatabase) };
  }

  // -------- Category C: Forward to ClickHouse --------
  return { type: 'forward', sql: rewriteForClickHouse(norm, currentDatabase) };
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

  // Multi-expression SELECT with only @@vars (e.g. mysql client init)
  // Example: SELECT @@version_comment, @@max_allowed_packet
  // Must be checked BEFORE single @@variable to handle comma-separated lists.
  // Only trigger when ALL comma-separated parts start with @@ (avoids false positives).
  if (expr.includes('@@') && expr.includes(',') && !expr.includes('FROM')) {
    const body = expr.replace(/\s+LIMIT\s+\d+$/i, '').trim();
    const allParts = body.split(',').map(p => p.trim());
    if (allParts.every(p => p.startsWith('@@') || /^@@/i.test(p.replace(/^.*\s+AS\s+/i, '')))) {
      return interceptMultiVariable(norm, connectionId, currentDatabase, currentUser);
    }
  }

  // @@variable patterns (single variable)
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

  // Catch any remaining @@var expressions without FROM (e.g. "SELECT @@unknown_var")
  if (expr.startsWith('@@') && !expr.includes('FROM')) {
    return interceptSystemVariable(expr, connectionId, currentDatabase, currentUser);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  System variable lookup                                             */
/* ------------------------------------------------------------------ */

const SYSTEM_VARS: Record<string, string> = {
  '@@VERSION': '8.0.32-Duckling',
  '@@VERSION_COMMENT': 'Duckling ClickHouse Server',
  '@@GLOBAL.VERSION': '8.0.32-Duckling',
  '@@GLOBAL.VERSION_COMMENT': 'Duckling ClickHouse Server',
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
