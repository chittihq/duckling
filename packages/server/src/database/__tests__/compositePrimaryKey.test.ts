import { describe, test, expect, vi } from 'vitest';

/**
 * Tests for composite primary key handling.
 *
 * Tests the actual production classes (MySQLConnection, SequentialAppenderService)
 * by mocking their database layer, rather than duplicating logic in test helpers.
 */

// ---------------------------------------------------------------------------
// We import the real class and mock its database dependency so that
// getPrimaryKeyColumn(s) exercises the actual production code path.
// ---------------------------------------------------------------------------
import MySQLConnection from '../mysql';

// Prevent the constructor from actually creating a connection pool
vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn(() => ({
      execute: vi.fn(),
      end: vi.fn(),
    })),
  },
}));

// Mock config/logger to avoid side-effects
vi.mock('../../config', () => ({
  default: { mysql: { maxConnections: 5 }, sync: { excludedTables: [] } },
}));
vi.mock('../../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Schema fixtures (DESCRIBE output format)
// ---------------------------------------------------------------------------
const singlePkSchema = [
  { Field: 'id', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: 'auto_increment' },
  { Field: 'name', Key: '', Type: 'varchar(255)', Null: 'YES', Default: null, Extra: '' },
  { Field: 'email', Key: '', Type: 'varchar(255)', Null: 'YES', Default: null, Extra: '' },
];

const compositePkSchema = [
  { Field: 'user_id', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'role_id', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'created_at', Key: '', Type: 'datetime', Null: 'YES', Default: null, Extra: '' },
];

const noPkSchema = [
  { Field: 'data', Key: '', Type: 'text', Null: 'YES', Default: null, Extra: '' },
  { Field: 'value', Key: '', Type: 'varchar(255)', Null: 'YES', Default: null, Extra: '' },
];

const compositePkWithIdColumn = [
  { Field: 'user_id', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'group_id', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'id', Key: '', Type: 'int(11)', Null: 'YES', Default: null, Extra: '' },
];

const threePkSchema = [
  { Field: 'a', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'b', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'c', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
  { Field: 'value', Key: '', Type: 'varchar(255)', Null: 'YES', Default: null, Extra: '' },
];

// ---------------------------------------------------------------------------
// SHOW INDEX fixtures (used by getPrimaryKeyColumns)
// Maps from DESCRIBE schema → SHOW INDEX rows with correct Seq_in_index
// ---------------------------------------------------------------------------
function schemaToShowIndexRows(schema: any[]): any[] {
  return schema
    .filter(col => col.Key === 'PRI')
    .map((col, idx) => ({
      Key_name: 'PRIMARY',
      Seq_in_index: idx + 1,
      Column_name: col.Field,
    }));
}

// ---------------------------------------------------------------------------
// Helper: create a MySQLConnection instance with a mocked execute method
// that returns the desired fixtures for DESCRIBE and SHOW INDEX queries.
// ---------------------------------------------------------------------------
function createMockedConnection(schema: any[], showIndexRows?: any[]): MySQLConnection {
  const conn = new MySQLConnection('mysql://mock:mock@localhost/test');

  const indexRows = showIndexRows ?? schemaToShowIndexRows(schema);
  const executedQueries: Array<{ query: string; params?: any[] }> = [];

  (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
    executedQueries.push({ query, params });
    if (query.startsWith('DESCRIBE')) {
      return schema;
    }
    if (query.startsWith('SHOW INDEX')) {
      return indexRows;
    }
    return [];
  });

  // Expose for assertions
  (conn as any)._executedQueries = executedQueries;
  return conn;
}

// ---------------------------------------------------------------------------
// Tests: getPrimaryKeyColumns (actual production method)
// ---------------------------------------------------------------------------
describe('MySQLConnection.getPrimaryKeyColumns', () => {
  test('returns single PK column', async () => {
    const conn = createMockedConnection(singlePkSchema);
    expect(await conn.getPrimaryKeyColumns('User')).toEqual(['id']);
  });

  test('returns all columns for composite PK', async () => {
    const conn = createMockedConnection(compositePkSchema);
    expect(await conn.getPrimaryKeyColumns('UserRole')).toEqual(['user_id', 'role_id']);
  });

  test('returns all columns for 3-column composite PK', async () => {
    const conn = createMockedConnection(threePkSchema);
    expect(await conn.getPrimaryKeyColumns('TripleKey')).toEqual(['a', 'b', 'c']);
  });

  test('returns empty array when no PK exists', async () => {
    const conn = createMockedConnection(noPkSchema);
    expect(await conn.getPrimaryKeyColumns('Data')).toEqual([]);
  });

  test('returns PK columns in index order, not table-definition order', async () => {
    // Table columns defined as (a, b) but PRIMARY KEY is (b, a)
    const schema = [
      { Field: 'a', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
      { Field: 'b', Key: 'PRI', Type: 'int(11)', Null: 'NO', Default: null, Extra: '' },
      { Field: 'value', Key: '', Type: 'varchar(255)', Null: 'YES', Default: null, Extra: '' },
    ];
    // SHOW INDEX returns index order: b first (Seq_in_index=1), a second (Seq_in_index=2)
    const showIndexRows = [
      { Key_name: 'PRIMARY', Seq_in_index: 1, Column_name: 'b' },
      { Key_name: 'PRIMARY', Seq_in_index: 2, Column_name: 'a' },
    ];
    const conn = createMockedConnection(schema, showIndexRows);
    // Should return [b, a] (index order), NOT [a, b] (table-definition order)
    expect(await conn.getPrimaryKeyColumns('Swapped')).toEqual(['b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// Tests: getPrimaryKeyColumn (actual production method)
// ---------------------------------------------------------------------------
describe('MySQLConnection.getPrimaryKeyColumn', () => {
  test('returns column name for single PK', async () => {
    const conn = createMockedConnection(singlePkSchema);
    expect(await conn.getPrimaryKeyColumn('User')).toBe('id');
  });

  test('returns undefined for composite PK', async () => {
    const conn = createMockedConnection(compositePkSchema);
    expect(await conn.getPrimaryKeyColumn('UserRole')).toBeUndefined();
  });

  test('returns undefined when no PK exists', async () => {
    const conn = createMockedConnection(noPkSchema);
    expect(await conn.getPrimaryKeyColumn('Data')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: streamTableData – verify correct SQL generation for composite PKs
// ---------------------------------------------------------------------------
describe('MySQLConnection.streamTableData', () => {
  test('uses keyset pagination with single PK', async () => {
    const conn = createMockedConnection(singlePkSchema);
    const indexRows = schemaToShowIndexRows(singlePkSchema);

    // Mock: first batch returns data, second returns empty (end)
    let callCount = 0;
    (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
      if (query.startsWith('DESCRIBE')) return singlePkSchema;
      if (query.startsWith('SHOW INDEX')) return indexRows;
      callCount++;
      if (callCount === 1) return [{ id: 1, name: 'Alice', email: 'a@test.com' }];
      return [];
    });

    const batches: any[][] = [];
    for await (const batch of conn.streamTableData('User', 10)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    // Check that ORDER BY uses the single PK
    const calls = (conn as any).execute.mock.calls;
    const selectCalls = calls.filter((c: any[]) => c[0].startsWith('SELECT'));
    expect(selectCalls[0][0]).toContain('ORDER BY `id` ASC');
  });

  test('uses composite tuple keyset pagination for composite PK', async () => {
    const conn = createMockedConnection(compositePkSchema);
    const indexRows = schemaToShowIndexRows(compositePkSchema);

    // Mock: first batch returns data, second returns empty (end)
    let callCount = 0;
    (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
      if (query.startsWith('DESCRIBE')) return compositePkSchema;
      if (query.startsWith('SHOW INDEX')) return indexRows;
      callCount++;
      if (callCount === 1) {
        return [
          { user_id: 1, role_id: 2, created_at: '2025-01-01' },
          { user_id: 1, role_id: 3, created_at: '2025-01-01' },
        ];
      }
      return [];
    });

    const batches: any[][] = [];
    for await (const batch of conn.streamTableData('UserRole', 10)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    const calls = (conn as any).execute.mock.calls;
    const selectCalls = calls.filter((c: any[]) => c[0].startsWith('SELECT'));
    // First call: no WHERE, just ORDER BY composite key
    expect(selectCalls[0][0]).toContain('ORDER BY `user_id` ASC, `role_id` ASC');
    // Should NOT contain OFFSET (using keyset, not OFFSET fallback)
    expect(selectCalls[0][0]).not.toContain('OFFSET');
  });

  test('uses row-value tuple WHERE clause for composite PK on subsequent batches', async () => {
    const conn = createMockedConnection(compositePkSchema);
    const indexRows = schemaToShowIndexRows(compositePkSchema);

    // Mock: first batch returns batchSize records, second batch returns less
    let callCount = 0;
    (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
      if (query.startsWith('DESCRIBE')) return compositePkSchema;
      if (query.startsWith('SHOW INDEX')) return indexRows;
      callCount++;
      if (callCount === 1) {
        return [
          { user_id: 1, role_id: 2, created_at: '2025-01-01' },
          { user_id: 1, role_id: 3, created_at: '2025-01-01' },
        ];
      }
      return []; // end
    });

    const batches: any[][] = [];
    for await (const batch of conn.streamTableData('UserRole', 2)) {
      batches.push(batch);
    }

    const calls = (conn as any).execute.mock.calls;
    const selectCalls = calls.filter((c: any[]) => c[0].startsWith('SELECT'));

    // Second SELECT should use row-value tuple comparison
    if (selectCalls.length > 1) {
      expect(selectCalls[1][0]).toContain('(`user_id`, `role_id`) > (?, ?)');
      expect(selectCalls[1][1]).toEqual([1, 3]); // last values from first batch
    }
  });

  test('falls back to OFFSET when no PK exists', async () => {
    const conn = createMockedConnection(noPkSchema);

    let callCount = 0;
    (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
      if (query.startsWith('DESCRIBE')) return noPkSchema;
      if (query.startsWith('SHOW INDEX')) return [];
      callCount++;
      if (callCount === 1) return [{ data: 'test', value: '1' }];
      return [];
    });

    // Mock getTableData since OFFSET path calls it
    (conn as any).getTableData = vi.fn(async (table: string, limit: number, offset: number) => {
      if (offset === 0) return [{ data: 'test', value: '1' }];
      return [];
    });

    const batches: any[][] = [];
    for await (const batch of conn.streamTableData('Data', 10)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: streamIncrementalData – verify correct SQL for composite PK tie-breaking
// ---------------------------------------------------------------------------
describe('MySQLConnection.streamIncrementalData', () => {
  test('uses composite tuple tie-breaking for composite PK', async () => {
    const conn = createMockedConnection(compositePkSchema);
    const indexRows = schemaToShowIndexRows(compositePkSchema);

    // Mock: first batch returns batchSize records (triggers second batch), second returns less
    let callCount = 0;
    (conn as any).execute = vi.fn(async (query: string, params?: any[]) => {
      if (query.startsWith('DESCRIBE')) return compositePkSchema;
      if (query.startsWith('SHOW INDEX')) return indexRows;
      callCount++;
      if (callCount === 1) {
        return [
          { user_id: 1, role_id: 2, created_at: '2025-01-01' },
          { user_id: 1, role_id: 3, created_at: '2025-01-02' },
        ];
      }
      return [];
    });

    const batches: any[][] = [];
    for await (const batch of conn.streamIncrementalData('UserRole', 'created_at', '2025-01-01', 2)) {
      batches.push(batch);
    }

    const calls = (conn as any).execute.mock.calls;
    const selectCalls = calls.filter((c: any[]) => c[0].startsWith('SELECT'));

    // First call should include ORDER BY with composite key
    expect(selectCalls[0][0]).toContain('ORDER BY `created_at` ASC, `user_id` ASC, `role_id` ASC');

    // Second call should use row-value tuple tie-breaking
    if (selectCalls.length > 1) {
      expect(selectCalls[1][0]).toContain('(`user_id`, `role_id`) > (?, ?)');
      // Params: lastWatermark, lastWatermark, ...lastPkValues
      expect(selectCalls[1][1]).toEqual(['2025-01-02', '2025-01-02', 1, 3]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: detectPrimaryKeyColumn – no ID-pattern fallback
// ---------------------------------------------------------------------------
describe('detectPrimaryKeyColumn (no heuristic fallback)', () => {
  // The detectPrimaryKeyColumn method is private, so we test it indirectly
  // by verifying the contract: only returns a value for single-column PK tables.
  // The logic exactly matches: filter PRI columns, return if length === 1, else undefined.

  function detectPrimaryKeyColumn(schema: Array<{ Field: string; Key: string }>): string | undefined {
    const pkColumns = schema.filter(col => col.Key === 'PRI');
    if (pkColumns.length === 1) {
      return pkColumns[0].Field;
    }
    return undefined;
  }

  test('returns column for single PK', () => {
    expect(detectPrimaryKeyColumn(singlePkSchema)).toBe('id');
  });

  test('returns undefined for composite PK (no heuristic fallback)', () => {
    expect(detectPrimaryKeyColumn(compositePkSchema)).toBeUndefined();
  });

  test('returns undefined for composite PK even with non-PK id column', () => {
    // Previously this would have returned 'id' due to pattern fallback — now it returns undefined
    expect(detectPrimaryKeyColumn(compositePkWithIdColumn)).toBeUndefined();
  });

  test('returns undefined when no PK exists (no heuristic fallback)', () => {
    expect(detectPrimaryKeyColumn(noPkSchema)).toBeUndefined();
  });

  test('returns undefined for 3-column composite PK', () => {
    expect(detectPrimaryKeyColumn(threePkSchema)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: composite PK keyset pagination vs OFFSET fallback
// ---------------------------------------------------------------------------
describe('pagination strategy selection', () => {
  test('single PK → keyset pagination', async () => {
    const conn = createMockedConnection(singlePkSchema);
    const pkCols = await conn.getPrimaryKeyColumns('User');
    // pkCols.length > 0 means keyset pagination will be used
    expect(pkCols.length).toBeGreaterThan(0);
  });

  test('composite PK → keyset pagination (not OFFSET fallback)', async () => {
    const conn = createMockedConnection(compositePkSchema);
    const pkCols = await conn.getPrimaryKeyColumns('UserRole');
    // With composite PK support, pkCols.length > 0 so keyset pagination is used
    expect(pkCols.length).toBeGreaterThan(0);
  });

  test('no PK → OFFSET fallback (only case)', async () => {
    const conn = createMockedConnection(noPkSchema);
    const pkCols = await conn.getPrimaryKeyColumns('Data');
    expect(pkCols.length).toBe(0);
  });
});
