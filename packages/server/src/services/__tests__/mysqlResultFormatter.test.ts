import { describe, test, expect } from 'vitest';
import {
  getMySQLTypeCode,
  buildColumnDefinition,
  formatValueByType,
  formatResultSet,
  singleValueResult,
  emptyResult,
} from '../mysqlResultFormatter';

// MySQL type code constants (from mysql2)
const TYPES = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  VARCHAR: 0x0f,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
};

// =====================================================================
// getMySQLTypeCode
// =====================================================================

describe('getMySQLTypeCode', () => {
  describe('string types', () => {
    test('VARCHAR -> VAR_STRING', () => expect(getMySQLTypeCode('VARCHAR')).toBe(TYPES.VAR_STRING));
    test('VARCHAR(255) strips qualifier', () => expect(getMySQLTypeCode('VARCHAR(255)')).toBe(TYPES.VAR_STRING));
    test('TEXT -> VAR_STRING', () => expect(getMySQLTypeCode('TEXT')).toBe(TYPES.VAR_STRING));
    test('CHAR -> STRING', () => expect(getMySQLTypeCode('CHAR')).toBe(TYPES.STRING));
  });

  describe('integer types', () => {
    test('TINYINT -> TINY', () => expect(getMySQLTypeCode('TINYINT')).toBe(TYPES.TINY));
    test('SMALLINT -> SHORT', () => expect(getMySQLTypeCode('SMALLINT')).toBe(TYPES.SHORT));
    test('INTEGER -> LONG', () => expect(getMySQLTypeCode('INTEGER')).toBe(TYPES.LONG));
    test('INT -> LONG', () => expect(getMySQLTypeCode('INT')).toBe(TYPES.LONG));
    test('BIGINT -> LONGLONG', () => expect(getMySQLTypeCode('BIGINT')).toBe(TYPES.LONGLONG));
    test('HUGEINT -> VAR_STRING (overflow safe)', () => expect(getMySQLTypeCode('HUGEINT')).toBe(TYPES.VAR_STRING));
    test('UBIGINT -> VAR_STRING (overflow safe)', () => expect(getMySQLTypeCode('UBIGINT')).toBe(TYPES.VAR_STRING));
  });

  describe('floating point', () => {
    test('FLOAT -> FLOAT', () => expect(getMySQLTypeCode('FLOAT')).toBe(TYPES.FLOAT));
    test('DOUBLE -> DOUBLE', () => expect(getMySQLTypeCode('DOUBLE')).toBe(TYPES.DOUBLE));
    test('REAL -> DOUBLE', () => expect(getMySQLTypeCode('REAL')).toBe(TYPES.DOUBLE));
  });

  describe('decimal', () => {
    test('DECIMAL -> NEWDECIMAL', () => expect(getMySQLTypeCode('DECIMAL')).toBe(TYPES.NEWDECIMAL));
    test('DECIMAL(10,2) strips qualifier', () => expect(getMySQLTypeCode('DECIMAL(10,2)')).toBe(TYPES.NEWDECIMAL));
    test('NUMERIC -> NEWDECIMAL', () => expect(getMySQLTypeCode('NUMERIC')).toBe(TYPES.NEWDECIMAL));
  });

  describe('boolean', () => {
    test('BOOLEAN -> TINY', () => expect(getMySQLTypeCode('BOOLEAN')).toBe(TYPES.TINY));
    test('BOOL -> TINY', () => expect(getMySQLTypeCode('BOOL')).toBe(TYPES.TINY));
  });

  describe('date/time types', () => {
    test('DATE -> DATE', () => expect(getMySQLTypeCode('DATE')).toBe(TYPES.DATE));
    test('TIME -> TIME', () => expect(getMySQLTypeCode('TIME')).toBe(TYPES.TIME));
    test('TIMESTAMP -> TIMESTAMP', () => expect(getMySQLTypeCode('TIMESTAMP')).toBe(TYPES.TIMESTAMP));
    test('DATETIME -> DATETIME', () => expect(getMySQLTypeCode('DATETIME')).toBe(TYPES.DATETIME));
    test('TIMESTAMP_NS -> TIMESTAMP', () => expect(getMySQLTypeCode('TIMESTAMP_NS')).toBe(TYPES.TIMESTAMP));
    test('TIMESTAMP WITH TIME ZONE -> TIMESTAMP', () => expect(getMySQLTypeCode('TIMESTAMP WITH TIME ZONE')).toBe(TYPES.TIMESTAMP));
  });

  describe('binary types', () => {
    test('BLOB -> BLOB', () => expect(getMySQLTypeCode('BLOB')).toBe(TYPES.BLOB));
    test('BYTEA -> BLOB', () => expect(getMySQLTypeCode('BYTEA')).toBe(TYPES.BLOB));
  });

  describe('JSON', () => {
    test('JSON -> JSON', () => expect(getMySQLTypeCode('JSON')).toBe(TYPES.JSON));
  });

  describe('special types', () => {
    test('UUID -> VAR_STRING', () => expect(getMySQLTypeCode('UUID')).toBe(TYPES.VAR_STRING));
    test('LIST -> VAR_STRING', () => expect(getMySQLTypeCode('LIST')).toBe(TYPES.VAR_STRING));
    test('STRUCT -> VAR_STRING', () => expect(getMySQLTypeCode('STRUCT')).toBe(TYPES.VAR_STRING));
    test('MAP -> VAR_STRING', () => expect(getMySQLTypeCode('MAP')).toBe(TYPES.VAR_STRING));
  });

  describe('edge cases', () => {
    test('empty string -> VAR_STRING (fallback)', () => expect(getMySQLTypeCode('')).toBe(TYPES.VAR_STRING));
    test('unknown type -> VAR_STRING (fallback)', () => expect(getMySQLTypeCode('GEOMETRY')).toBe(TYPES.VAR_STRING));
    test('lowercase input normalised', () => expect(getMySQLTypeCode('bigint')).toBe(TYPES.LONGLONG));
  });
});

// =====================================================================
// buildColumnDefinition
// =====================================================================

describe('buildColumnDefinition', () => {
  test('sets name and orgName', () => {
    const col = buildColumnDefinition('user_id');
    expect(col.name).toBe('user_id');
    expect(col.orgName).toBe('user_id');
  });

  test('catalog is def', () => {
    expect(buildColumnDefinition('x').catalog).toBe('def');
  });

  test('uses duckdbType for column type code', () => {
    const col = buildColumnDefinition('id', 'BIGINT');
    expect(col.columnType).toBe(TYPES.LONGLONG);
  });

  test('defaults to VARCHAR when no type given', () => {
    const col = buildColumnDefinition('name');
    expect(col.columnType).toBe(TYPES.VAR_STRING);
  });

  test('sets table name when provided', () => {
    const col = buildColumnDefinition('id', 'INT', 'users');
    expect(col.table).toBe('users');
    expect(col.orgTable).toBe('users');
  });

  test('characterSet is utf8mb4 (45)', () => {
    expect(buildColumnDefinition('x').characterSet).toBe(45);
  });
});

// =====================================================================
// formatValueByType
// =====================================================================

describe('formatValueByType', () => {
  test('null -> null', () => {
    expect(formatValueByType(null)).toBeNull();
  });

  test('undefined -> null', () => {
    expect(formatValueByType(undefined)).toBeNull();
  });

  test('boolean true -> "1"', () => {
    expect(formatValueByType(true)).toBe('1');
  });

  test('boolean false -> "0"', () => {
    expect(formatValueByType(false)).toBe('0');
  });

  test('bigint -> string', () => {
    expect(formatValueByType(9007199254740993n)).toBe('9007199254740993');
  });

  test('Buffer -> hex string', () => {
    expect(formatValueByType(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  test('Uint8Array -> hex string', () => {
    expect(formatValueByType(new Uint8Array([0xca, 0xfe]))).toBe('cafe');
  });

  describe('Date formatting', () => {
    const d = new Date('2025-06-15T12:30:45.000Z');

    test('no type hint -> full timestamp', () => {
      expect(formatValueByType(d)).toBe('2025-06-15 12:30:45.000');
    });

    test('DATE type -> date only', () => {
      expect(formatValueByType(d, 'DATE')).toBe('2025-06-15');
    });

    test('TIME type -> time only', () => {
      expect(formatValueByType(d, 'TIME')).toBe('12:30:45');
    });

    test('TIMESTAMP type -> full timestamp', () => {
      expect(formatValueByType(d, 'TIMESTAMP')).toBe('2025-06-15 12:30:45.000');
    });
  });

  test('DuckDB object with micros property uses toString', () => {
    const duckdbTime = { micros: 45045000000n, toString: () => '12:30:45' };
    expect(formatValueByType(duckdbTime)).toBe('12:30:45');
  });

  test('plain object -> JSON string', () => {
    expect(formatValueByType({ a: 1, b: 'test' })).toBe('{"a":1,"b":"test"}');
  });

  test('object with bigint -> bigint serialized as string', () => {
    expect(formatValueByType({ id: 123n })).toBe('{"id":"123"}');
  });

  test('array -> JSON string', () => {
    expect(formatValueByType([1, 2, 3])).toBe('[1,2,3]');
  });

  test('string -> string', () => {
    expect(formatValueByType('hello')).toBe('hello');
  });

  test('number -> string', () => {
    expect(formatValueByType(42)).toBe('42');
    expect(formatValueByType(3.14)).toBe('3.14');
  });
});

// =====================================================================
// formatResultSet
// =====================================================================

describe('formatResultSet', () => {
  test('formats columns and rows together', () => {
    const result = formatResultSet(
      ['id', 'name'],
      ['BIGINT', 'VARCHAR'],
      [[1, 'Alice'], [2, 'Bob']],
    );
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0].name).toBe('id');
    expect(result.columns[0].columnType).toBe(TYPES.LONGLONG);
    expect(result.columns[1].columnType).toBe(TYPES.VAR_STRING);
    expect(result.rows).toEqual([['1', 'Alice'], ['2', 'Bob']]);
  });

  test('null values preserved in rows', () => {
    const result = formatResultSet(['x'], ['VARCHAR'], [[null]]);
    expect(result.rows[0][0]).toBeNull();
  });

  test('empty result set', () => {
    const result = formatResultSet(['a'], ['INT'], []);
    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(0);
  });

  test('passes table name to column definitions', () => {
    const result = formatResultSet(['id'], ['INT'], [[1]], 'users');
    expect(result.columns[0].table).toBe('users');
  });
});

// =====================================================================
// singleValueResult / emptyResult
// =====================================================================

describe('singleValueResult', () => {
  test('creates single column single row', () => {
    const r = singleValueResult('count', 42);
    expect(r.columns).toHaveLength(1);
    expect(r.columns[0].name).toBe('count');
    expect(r.rows).toEqual([['42']]);
  });

  test('null value preserved', () => {
    const r = singleValueResult('x', null);
    expect(r.rows[0][0]).toBeNull();
  });

  test('string value', () => {
    const r = singleValueResult('ver', '8.0.32');
    expect(r.rows[0][0]).toBe('8.0.32');
  });

  test('respects duckdbType', () => {
    const r = singleValueResult('id', 1, 'BIGINT');
    expect(r.columns[0].columnType).toBe(TYPES.LONGLONG);
  });
});

describe('emptyResult', () => {
  test('creates columns with zero rows', () => {
    const r = emptyResult(['Level', 'Code', 'Message']);
    expect(r.columns).toHaveLength(3);
    expect(r.columns[0].name).toBe('Level');
    expect(r.rows).toHaveLength(0);
  });

  test('respects duckdbTypes', () => {
    const r = emptyResult(['id', 'name'], ['BIGINT', 'VARCHAR']);
    expect(r.columns[0].columnType).toBe(TYPES.LONGLONG);
    expect(r.columns[1].columnType).toBe(TYPES.VAR_STRING);
  });

  test('defaults to VARCHAR when no types given', () => {
    const r = emptyResult(['x']);
    expect(r.columns[0].columnType).toBe(TYPES.VAR_STRING);
  });
});
