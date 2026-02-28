import { describe, test, expect } from 'vitest';
import { mapMySQLTypeToDuckDB } from '../dumpService';

describe('mapMySQLTypeToDuckDB (dump path)', () => {
  // Regression: JSON must map to JSON, not VARCHAR
  test('json -> JSON', () => {
    expect(mapMySQLTypeToDuckDB('json')).toBe('JSON');
  });

  // Regression: tinyint/smallint/mediumint must not be swallowed by int( check
  test('tinyint(4) -> TINYINT', () => {
    expect(mapMySQLTypeToDuckDB('tinyint(4)')).toBe('TINYINT');
  });

  test('tinyint(1) -> TINYINT', () => {
    expect(mapMySQLTypeToDuckDB('tinyint(1)')).toBe('TINYINT');
  });

  test('smallint(6) -> SMALLINT', () => {
    expect(mapMySQLTypeToDuckDB('smallint(6)')).toBe('SMALLINT');
  });

  test('mediumint(9) -> BIGINT', () => {
    expect(mapMySQLTypeToDuckDB('mediumint(9)')).toBe('BIGINT');
  });

  test('int(11) -> BIGINT', () => {
    expect(mapMySQLTypeToDuckDB('int(11)')).toBe('BIGINT');
  });

  test('int -> BIGINT', () => {
    expect(mapMySQLTypeToDuckDB('int')).toBe('BIGINT');
  });

  test('bigint -> BIGINT', () => {
    expect(mapMySQLTypeToDuckDB('bigint')).toBe('BIGINT');
  });

  // Regression: enum containing 'int' must not match integer branch
  test("enum('Internship','FullTime') -> VARCHAR", () => {
    expect(mapMySQLTypeToDuckDB("enum('Internship','FullTime')")).toBe('VARCHAR');
  });

  test('set -> VARCHAR', () => {
    expect(mapMySQLTypeToDuckDB("set('a','b','c')")).toBe('VARCHAR');
  });

  test('bit(1) -> VARCHAR', () => {
    expect(mapMySQLTypeToDuckDB('bit(1)')).toBe('VARCHAR');
  });

  // Standard types
  test('varchar(255) -> VARCHAR', () => {
    expect(mapMySQLTypeToDuckDB('varchar(255)')).toBe('VARCHAR');
  });

  test('text -> TEXT', () => {
    expect(mapMySQLTypeToDuckDB('text')).toBe('TEXT');
  });

  test('blob -> BLOB', () => {
    expect(mapMySQLTypeToDuckDB('blob')).toBe('BLOB');
  });

  test('timestamp -> TIMESTAMP', () => {
    expect(mapMySQLTypeToDuckDB('timestamp')).toBe('TIMESTAMP');
  });

  test('datetime -> TIMESTAMP', () => {
    expect(mapMySQLTypeToDuckDB('datetime')).toBe('TIMESTAMP');
  });

  test('date -> DATE', () => {
    expect(mapMySQLTypeToDuckDB('date')).toBe('DATE');
  });

  test('decimal(10,2) -> DECIMAL', () => {
    expect(mapMySQLTypeToDuckDB('decimal(10,2)')).toBe('DECIMAL');
  });

  test('boolean -> BOOLEAN', () => {
    expect(mapMySQLTypeToDuckDB('boolean')).toBe('BOOLEAN');
  });

  test('float -> FLOAT', () => {
    expect(mapMySQLTypeToDuckDB('float')).toBe('FLOAT');
  });

  test('double -> DOUBLE', () => {
    expect(mapMySQLTypeToDuckDB('double')).toBe('DOUBLE');
  });

  // Unknown type falls through to VARCHAR
  test('geometry -> VARCHAR (unsupported)', () => {
    expect(mapMySQLTypeToDuckDB('geometry')).toBe('VARCHAR');
  });

  // 'point' contains 'int' so it hits the int branch — matches current behavior
  test('point -> BIGINT (contains int substring)', () => {
    expect(mapMySQLTypeToDuckDB('point')).toBe('BIGINT');
  });
});
