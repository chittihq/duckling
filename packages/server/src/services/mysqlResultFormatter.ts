/**
 * MySQL Result Formatter
 *
 * Maps ClickHouse query results to MySQL wire protocol result sets.
 * Handles type mapping between ClickHouse column types and MySQL type codes.
 */

// MySQL type codes from mysql2/lib/constants/types
const MySQLTypes = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  VARCHAR: 0x0f,
  BIT: 0x10,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
} as const;

/** Map ClickHouse type names (upper-case) to MySQL type codes */
const CLICKHOUSE_TO_MYSQL_TYPE: Record<string, number> = {
  // String types
  VARCHAR: MySQLTypes.VAR_STRING,
  TEXT: MySQLTypes.VAR_STRING,
  STRING: MySQLTypes.VAR_STRING,
  CHAR: MySQLTypes.STRING,

  // Integer types
  TINYINT: MySQLTypes.TINY,
  SMALLINT: MySQLTypes.SHORT,
  INTEGER: MySQLTypes.LONG,
  INT: MySQLTypes.LONG,
  BIGINT: MySQLTypes.LONGLONG,
  HUGEINT: MySQLTypes.VAR_STRING, // sent as string to avoid overflow
  UBIGINT: MySQLTypes.VAR_STRING,
  UINTEGER: MySQLTypes.LONGLONG,
  USMALLINT: MySQLTypes.LONG,
  UTINYINT: MySQLTypes.SHORT,
  INT128: MySQLTypes.VAR_STRING,

  // Floating point
  FLOAT: MySQLTypes.FLOAT,
  DOUBLE: MySQLTypes.DOUBLE,
  REAL: MySQLTypes.DOUBLE,

  // Decimal
  DECIMAL: MySQLTypes.NEWDECIMAL,
  NUMERIC: MySQLTypes.NEWDECIMAL,

  // Boolean
  BOOLEAN: MySQLTypes.TINY,
  BOOL: MySQLTypes.TINY,

  // Date/time types
  DATE: MySQLTypes.DATE,
  TIME: MySQLTypes.TIME,
  TIMESTAMP: MySQLTypes.TIMESTAMP,
  DATETIME: MySQLTypes.DATETIME,
  TIMESTAMP_NS: MySQLTypes.TIMESTAMP,
  TIMESTAMP_MS: MySQLTypes.TIMESTAMP,
  TIMESTAMP_S: MySQLTypes.TIMESTAMP,
  TIMESTAMP_TZ: MySQLTypes.TIMESTAMP,
  'TIMESTAMP WITH TIME ZONE': MySQLTypes.TIMESTAMP,

  // Binary types
  BLOB: MySQLTypes.BLOB,
  BYTEA: MySQLTypes.BLOB,

  // JSON
  JSON: MySQLTypes.JSON,

  // Special types
  UUID: MySQLTypes.VAR_STRING,
  INTERVAL: MySQLTypes.VAR_STRING,
  BIT: MySQLTypes.BIT,

  // Complex types (sent as string)
  LIST: MySQLTypes.VAR_STRING,
  STRUCT: MySQLTypes.VAR_STRING,
  MAP: MySQLTypes.VAR_STRING,
  ARRAY: MySQLTypes.VAR_STRING,
  UNION: MySQLTypes.VAR_STRING,
  ENUM: MySQLTypes.VAR_STRING,
};

export interface MySQLColumnDefinition {
  catalog: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  characterSet: number;
  columnLength: number;
  columnType: number;
  flags: number;
  decimals: number;
}

/**
 * Get the MySQL type code for a ClickHouse type string.
 * Strips size/precision qualifiers (e.g. "VARCHAR(255)" → "VARCHAR").
 */
export function getMySQLTypeCode(clickhouseType: string): number {
  if (!clickhouseType) return MySQLTypes.VAR_STRING;
  // Strip parenthetical qualifiers and normalize
  const baseType = clickhouseType.replace(/\(.*\)/, '').trim().toUpperCase();
  return CLICKHOUSE_TO_MYSQL_TYPE[baseType] ?? MySQLTypes.VAR_STRING;
}

/**
 * Build a MySQL column definition from a column name and ClickHouse type.
 */
export function buildColumnDefinition(
  name: string,
  clickhouseType?: string,
  table?: string,
): MySQLColumnDefinition {
  const columnType = getMySQLTypeCode(clickhouseType || 'VARCHAR');
  return {
    catalog: 'def',
    schema: '',
    table: table || '',
    orgTable: table || '',
    name,
    orgName: name,
    characterSet: 45, // utf8mb4_general_ci
    columnLength: 255,
    columnType,
    flags: 0,
    decimals: 0,
  };
}

/**
 * Build a conservative column definition for forwarded ClickHouse result sets.
 * Some MySQL clients are stricter about typed text-protocol decoding than
 * mysql2's server-side API is about advertised metadata, so we prefer
 * string-compatible field types for anything beyond simple integers.
 */
export function buildForwardedColumnDefinition(
  name: string,
  clickhouseType?: string,
  table?: string,
): MySQLColumnDefinition {
  const baseType = baseClickHouseType(clickhouseType);

  switch (baseType) {
    case 'TINYINT':
    case 'SMALLINT':
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
      return buildColumnDefinition(name, clickhouseType, table);

    default:
      return buildColumnDefinition(name, 'VARCHAR', table);
  }
}

function baseClickHouseType(clickhouseType?: string): string {
  if (!clickhouseType) return '';
  return clickhouseType.replace(/\(.*\)/, '').trim().toUpperCase();
}

/**
 * Convert a single ClickHouse value to a MySQL text-protocol value.
 * `clickhouseType` is optional but improves date/time fidelity for client decoders.
 */
export function formatValueByType(value: any, clickhouseType?: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const type = baseClickHouseType(clickhouseType);
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (value instanceof Date) {
    if (type === 'DATE') {
      return value.toISOString().slice(0, 10);
    }
    if (type === 'TIME') {
      return value.toISOString().slice(11, 19);
    }
    return value.toISOString().replace('T', ' ').replace('Z', '');
  }
  // Timestamp-like objects with a .toString()
  if (typeof value === 'object' && typeof value.toString === 'function' && value.micros !== undefined) {
    return value.toString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(
      value,
      (_key, innerValue) => (typeof innerValue === 'bigint' ? innerValue.toString() : innerValue),
    );
  }
  return String(value);
}

/**
 * Format a full result set for writeTextResult.
 * Returns { columns, rows } where rows are arrays of string|null values.
 */
export function formatResultSet(
  columnNames: string[],
  columnTypes: string[],
  rows: any[][],
  table?: string,
): { columns: MySQLColumnDefinition[]; rows: (string | null)[][] } {
  const columns = columnNames.map((name, i) =>
    buildColumnDefinition(name, columnTypes[i], table),
  );
  const formattedRows = rows.map(row =>
    row.map((val, i) => formatValueByType(val, columnTypes[i])),
  );
  return { columns, rows: formattedRows };
}

/**
 * Create a simple single-column, single-row result set.
 * Useful for SELECT @@variable style queries.
 */
export function singleValueResult(
  columnName: string,
  value: string | number | null,
  clickhouseType?: string,
): { columns: MySQLColumnDefinition[]; rows: (string | null)[][] } {
  return {
    columns: [buildColumnDefinition(columnName, clickhouseType || 'VARCHAR')],
    rows: [[value === null ? null : String(value)]],
  };
}

/**
 * Create an empty result set with the given column definitions.
 */
export function emptyResult(
  columnNames: string[],
  clickhouseTypes?: string[],
): { columns: MySQLColumnDefinition[]; rows: (string | null)[][] } {
  const columns = columnNames.map((name, i) =>
    buildColumnDefinition(name, clickhouseTypes?.[i] || 'VARCHAR'),
  );
  return { columns, rows: [] };
}
