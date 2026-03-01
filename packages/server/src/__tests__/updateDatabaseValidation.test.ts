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
});
