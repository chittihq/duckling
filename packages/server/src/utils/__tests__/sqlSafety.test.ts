import { describe, expect, test } from 'vitest';
import { isReadOnlyMySQLQuery } from '../sqlSafety';

describe('isReadOnlyMySQLQuery', () => {
  test('allows read-only statements', () => {
    expect(isReadOnlyMySQLQuery('SELECT * FROM users')).toBe(true);
    expect(isReadOnlyMySQLQuery('SHOW TABLES;')).toBe(true);
    expect(isReadOnlyMySQLQuery('DESCRIBE `users`')).toBe(true);
    expect(isReadOnlyMySQLQuery('EXPLAIN SELECT * FROM users')).toBe(true);
  });

  test('allows read-only statements with leading comments', () => {
    expect(isReadOnlyMySQLQuery('-- comment\nSELECT 1')).toBe(true);
    expect(isReadOnlyMySQLQuery('/* comment */ SELECT 1')).toBe(true);
    expect(isReadOnlyMySQLQuery('# comment\nSHOW TABLES')).toBe(true);
  });

  test('rejects write statements', () => {
    expect(isReadOnlyMySQLQuery('DELETE FROM users')).toBe(false);
    expect(isReadOnlyMySQLQuery('UPDATE users SET name = "x"')).toBe(false);
    expect(isReadOnlyMySQLQuery('DROP TABLE users')).toBe(false);
  });

  test('rejects multiple statements', () => {
    expect(isReadOnlyMySQLQuery('SELECT 1; DROP TABLE users')).toBe(false);
    expect(isReadOnlyMySQLQuery('SELECT 1; /* comment */ DROP TABLE users')).toBe(false);
  });

  test('allows semicolons in string literals', () => {
    expect(isReadOnlyMySQLQuery("SELECT ';' AS value")).toBe(true);
  });

  test('allows semicolons in comments and trailing commented semicolon', () => {
    expect(isReadOnlyMySQLQuery('SELECT 1 /* ; inside comment */')).toBe(true);
    expect(isReadOnlyMySQLQuery('SELECT 1; -- trailing comment')).toBe(true);
  });

  test('rejects EXPLAIN ANALYZE', () => {
    expect(isReadOnlyMySQLQuery('EXPLAIN ANALYZE SELECT 1')).toBe(false);
    expect(isReadOnlyMySQLQuery('EXPLAIN ANALYZE DELETE FROM users')).toBe(false);
  });

  test('rejects cte queries to avoid write-capable WITH statements', () => {
    expect(isReadOnlyMySQLQuery('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
  });
});
