import { describe, test, expect } from 'vitest';

/**
 * Tests for composite primary key handling.
 *
 * The core logic lives in:
 *   - MySQLConnection.getPrimaryKeyColumn(s)  → packages/server/src/database/mysql.ts
 *   - SequentialAppenderService.detectPrimaryKeyColumn → packages/server/src/services/sequentialAppenderService.ts
 *
 * Because both classes require live database connections we test the *extracted*
 * logic here without touching the network.
 */

// ---------------------------------------------------------------------------
// Helpers that mirror the production logic so we can assert behaviour without
// needing a real MySQL/DuckDB connection.
// ---------------------------------------------------------------------------

/** Mirrors MySQLConnection.getPrimaryKeyColumns */
function getPrimaryKeyColumns(schema: Array<{ Field: string; Key: string }>): string[] {
  return schema.filter(col => col.Key === 'PRI').map(col => col.Field);
}

/** Mirrors MySQLConnection.getPrimaryKeyColumn */
function getPrimaryKeyColumn(schema: Array<{ Field: string; Key: string }>): string | undefined {
  const pkColumns = getPrimaryKeyColumns(schema);
  return pkColumns.length === 1 ? pkColumns[0] : undefined;
}

/** Mirrors SequentialAppenderService.detectPrimaryKeyColumn */
function detectPrimaryKeyColumn(
  tableName: string,
  schema: Array<{ Field: string; Key: string }>
): string | undefined {
  const pkColumns = schema.filter(col => col.Key === 'PRI');
  if (pkColumns.length === 1) {
    return pkColumns[0].Field;
  }

  // Composite PK or no PK – fall back to common ID patterns
  const idPatterns = [
    'id',
    `${tableName.toLowerCase()}id`,
    `${tableName.toLowerCase()}_id`,
  ];

  for (const pattern of idPatterns) {
    const column = schema.find(col => col.Field.toLowerCase() === pattern);
    if (column) {
      return column.Field;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------
const singlePkSchema = [
  { Field: 'id', Key: 'PRI' },
  { Field: 'name', Key: '' },
  { Field: 'email', Key: '' },
];

const compositePkSchema = [
  { Field: 'user_id', Key: 'PRI' },
  { Field: 'role_id', Key: 'PRI' },
  { Field: 'created_at', Key: '' },
];

const noPkSchema = [
  { Field: 'data', Key: '' },
  { Field: 'value', Key: '' },
];

const noPkWithIdColumn = [
  { Field: 'id', Key: '' },
  { Field: 'data', Key: '' },
];

const compositePkWithIdColumn = [
  { Field: 'user_id', Key: 'PRI' },
  { Field: 'group_id', Key: 'PRI' },
  { Field: 'id', Key: '' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getPrimaryKeyColumns', () => {
  test('returns single PK column', () => {
    expect(getPrimaryKeyColumns(singlePkSchema)).toEqual(['id']);
  });

  test('returns all columns for composite PK', () => {
    expect(getPrimaryKeyColumns(compositePkSchema)).toEqual(['user_id', 'role_id']);
  });

  test('returns empty array when no PK exists', () => {
    expect(getPrimaryKeyColumns(noPkSchema)).toEqual([]);
  });
});

describe('getPrimaryKeyColumn', () => {
  test('returns column name for single PK', () => {
    expect(getPrimaryKeyColumn(singlePkSchema)).toBe('id');
  });

  test('returns undefined for composite PK', () => {
    expect(getPrimaryKeyColumn(compositePkSchema)).toBeUndefined();
  });

  test('returns undefined when no PK exists', () => {
    expect(getPrimaryKeyColumn(noPkSchema)).toBeUndefined();
  });
});

describe('detectPrimaryKeyColumn', () => {
  test('returns column for single PK', () => {
    expect(detectPrimaryKeyColumn('User', singlePkSchema)).toBe('id');
  });

  test('returns undefined for composite PK (no id fallback)', () => {
    // Composite PK with no 'id' column → undefined, triggers OFFSET pagination
    expect(detectPrimaryKeyColumn('UserRole', compositePkSchema)).toBeUndefined();
  });

  test('falls back to id column for composite PK when id column exists', () => {
    // Composite PK but table also has a non-PK 'id' column → use it
    expect(detectPrimaryKeyColumn('UserGroup', compositePkWithIdColumn)).toBe('id');
  });

  test('returns undefined when no PK and no id column', () => {
    expect(detectPrimaryKeyColumn('Data', noPkSchema)).toBeUndefined();
  });

  test('falls back to id column when no PK but id column exists', () => {
    expect(detectPrimaryKeyColumn('Metrics', noPkWithIdColumn)).toBe('id');
  });

  test('falls back to tablenameid pattern', () => {
    const schema = [
      { Field: 'userid', Key: '' },
      { Field: 'name', Key: '' },
    ];
    expect(detectPrimaryKeyColumn('User', schema)).toBe('userid');
  });

  test('falls back to tablename_id pattern', () => {
    const schema = [
      { Field: 'order_id', Key: '' },
      { Field: 'total', Key: '' },
    ];
    expect(detectPrimaryKeyColumn('Order', schema)).toBe('order_id');
  });
});

describe('composite PK → OFFSET fallback logic', () => {
  test('single PK enables keyset pagination', () => {
    const pk = getPrimaryKeyColumn(singlePkSchema);
    // When pk is truthy, streamTableData uses keyset pagination
    expect(pk).toBeTruthy();
  });

  test('composite PK triggers OFFSET fallback', () => {
    const pk = getPrimaryKeyColumn(compositePkSchema);
    // When pk is falsy, streamTableData falls back to OFFSET pagination
    expect(pk).toBeFalsy();
  });

  test('no PK triggers OFFSET fallback', () => {
    const pk = getPrimaryKeyColumn(noPkSchema);
    expect(pk).toBeFalsy();
  });
});
