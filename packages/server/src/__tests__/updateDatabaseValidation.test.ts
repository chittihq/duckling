import { describe, expect, it } from 'vitest';
import { validateDatabaseUpdatePayload } from '../server';

describe('validateDatabaseUpdatePayload', () => {
  it('accepts only allowed database update fields', () => {
    const result = validateDatabaseUpdatePayload({
      name: 'Updated DB',
      mysqlConnectionString: 'mysql://user:pass@localhost:3306/db'
    });

    expect(result.error).toBeUndefined();
    expect(result.updates).toEqual({
      name: 'Updated DB',
      mysqlConnectionString: 'mysql://user:pass@localhost:3306/db'
    });
  });

  it('rejects protected and unknown fields', () => {
    const result = validateDatabaseUpdatePayload({
      name: 'Updated DB',
      id: 'hijack-db',
      duckdbPath: 'data/other.db'
    });

    expect(result.updates).toBeUndefined();
    expect(result.error).toContain('Invalid update fields');
    expect(result.error).toContain('id');
    expect(result.error).toContain('duckdbPath');
  });

  it('accepts empty update object', () => {
    const result = validateDatabaseUpdatePayload({});
    expect(result.error).toBeUndefined();
    expect(result.updates).toEqual({});
  });

  it('rejects invalid body shapes', () => {
    expect(validateDatabaseUpdatePayload(null).error).toBe('Request body must be an object');
    expect(validateDatabaseUpdatePayload([]).error).toBe('Request body must be an object');
  });

  it('rejects invalid values for allowed fields', () => {
    expect(validateDatabaseUpdatePayload({ name: '   ' }).error).toBe('name must be a non-empty string');
    expect(validateDatabaseUpdatePayload({ name: 123 }).error).toBe('name must be a non-empty string');
    expect(validateDatabaseUpdatePayload({ mysqlConnectionString: 123 }).error).toBe('mysqlConnectionString must be a non-empty string');
  });
});
