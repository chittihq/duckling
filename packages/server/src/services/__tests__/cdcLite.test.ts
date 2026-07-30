import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// --- Fake zongji: an EventEmitter we can push binlog events through ---
const { fakeZongjis } = vi.hoisted(() => ({
  fakeZongjis: [] as any[],
}));

vi.mock('@vlasky/zongji', async () => {
  const { EventEmitter } = await import('events');
  class FakeZongJi extends EventEmitter {
    startOptions: any = null;
    stopped = false;
    gtidSet: string | undefined = undefined;
    constructor(public dsn: any) {
      super();
      fakeZongjis.push(this);
    }
    start(options: any): void {
      this.startOptions = options;
      this.emit('ready');
    }
    stop(): void {
      this.stopped = true;
    }
  }
  return { __esModule: true, default: FakeZongJi };
});

vi.mock('../../logger', () => ({
  __esModule: true,
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  __esModule: true,
  default: {
    cdcLite: { enabled: true },
    clickhouse: { finalReads: true },
  },
}));

import BinlogTailerService from '../binlogTailerService';

type Mocks = {
  mysql: any;
  clickhouse: any;
  syncService: any;
};

function makeMocks(overrides: Partial<Record<string, any>> = {}): Mocks {
  const mysql = {
    getConnectionOptions: vi.fn(() => ({ host: 'db', port: 3306, user: 'u', password: 'p', database: 'testdb' })),
    getTables: vi.fn(async () => ['users']),
    getPrimaryKeyColumns: vi.fn(async () => ['id']),
    getUniqueKeyColumns: vi.fn(async () => []),
    ...overrides.mysql,
  };
  const clickhouse = {
    execute: vi.fn(async () => []),
    insert: vi.fn(async () => undefined),
    run: vi.fn(async () => undefined),
    ...overrides.clickhouse,
  };
  const syncService = {
    refreshProjectionView: vi.fn(async () => undefined),
    syncSingleTable: vi.fn(async () => ({ status: 'success', recordsProcessed: 1 })),
    ...overrides.syncService,
  };
  return { mysql, clickhouse, syncService };
}

function rowEvent(name: string, tableName: string, rows: any[]): any {
  return {
    getEventName: () => name,
    tableId: 7,
    nextPosition: 1234,
    tableMap: { 7: { tableName, parentSchema: 'testdb' } },
    rows,
  };
}

let idCounter = 0;

describe('CDC-lite binlog tailer', () => {
  let dbId: string;
  let mocks: Mocks;
  let tailer: BinlogTailerService;

  beforeEach(async () => {
    dbId = `cdclite-test-${idCounter++}`;
    fakeZongjis.length = 0;
    mocks = makeMocks();
    tailer = BinlogTailerService.getInstance(dbId, mocks.mysql, mocks.clickhouse, mocks.syncService);
    await tailer.start();
  });

  afterEach(async () => {
    await BinlogTailerService.closeInstance(dbId);
    vi.clearAllMocks();
  });

  test('refreshes projection views on start and begins from current position with no checkpoint', () => {
    expect(mocks.syncService.refreshProjectionView).toHaveBeenCalledWith('users');
    expect(fakeZongjis).toHaveLength(1);
    expect(fakeZongjis[0].startOptions.startAtEnd).toBe(true);
    expect(fakeZongjis[0].startOptions.includeSchema).toEqual({ testdb: true });
  });

  test('delete event writes a tombstone with the PK and _sync_deleted=1', async () => {
    fakeZongjis[0].emit('binlog', rowEvent('deleterows', 'users', [{ id: 42, name: 'gone' }]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.clickhouse.insert).toHaveBeenCalledTimes(1);
    const [table, rows, columns] = mocks.clickhouse.insert.mock.calls[0];
    expect(table).toBe('users__raw');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(42);
    expect(rows[0]._sync_deleted).toBe(1);
    expect(rows[0].name).toBeUndefined(); // only dedup-key + sync columns forwarded
    expect(columns).toContain('id');
    expect(columns).toContain('_sync_deleted');
    expect(tailer.getStatus().tombstonesWritten).toBe(1);
  });

  test('falls back to UNIQUE key for tombstones when the table has no PK', async () => {
    mocks.mysql.getPrimaryKeyColumns.mockResolvedValue([]);
    mocks.mysql.getUniqueKeyColumns.mockResolvedValue(['email']);

    fakeZongjis[0].emit('binlog', rowEvent('deleterows', 'users', [{ id: 1, email: 'a@b.c' }]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [, rows] = mocks.clickhouse.insert.mock.calls[0];
    expect(rows[0].email).toBe('a@b.c');
    expect(rows[0].id).toBeUndefined();
  });

  test('no PK and no UNIQUE key: delete is skipped, not written', async () => {
    mocks.mysql.getPrimaryKeyColumns.mockResolvedValue([]);
    mocks.mysql.getUniqueKeyColumns.mockResolvedValue([]);

    fakeZongjis[0].emit('binlog', rowEvent('deleterows', 'users', [{ id: 1 }]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.clickhouse.insert).not.toHaveBeenCalled();
  });

  test('insert/update events nudge a per-table incremental sync (debounced)', async () => {
    fakeZongjis[0].emit('binlog', rowEvent('writerows', 'users', [{ id: 1 }]));
    fakeZongjis[0].emit('binlog', rowEvent('updaterows', 'users', [{ before: { id: 1 }, after: { id: 1 } }]));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Two events, one debounced nudge for the table.
    expect(mocks.syncService.syncSingleTable).toHaveBeenCalledTimes(1);
    expect(mocks.syncService.syncSingleTable).toHaveBeenCalledWith('users');
  });

  test('ALTER TABLE (query event) invalidates the cached dedup key', async () => {
    // First delete caches ['id'] as the key.
    fakeZongjis[0].emit('binlog', rowEvent('deleterows', 'users', [{ id: 1, uid: 'a' }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.clickhouse.insert.mock.calls[0][1][0].id).toBe(1);

    // Schema change swaps the PK column; without invalidation the stale
    // cached key would produce tombstones keyed on the wrong column.
    mocks.mysql.getPrimaryKeyColumns.mockResolvedValue(['uid']);
    fakeZongjis[0].emit('binlog', {
      getEventName: () => 'query',
      query: 'ALTER TABLE users DROP PRIMARY KEY, ADD PRIMARY KEY (uid)',
      nextPosition: 2345,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeZongjis[0].emit('binlog', rowEvent('deleterows', 'users', [{ id: 2, uid: 'b' }]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondTombstone = mocks.clickhouse.insert.mock.calls[1][1][0];
    expect(secondTombstone.uid).toBe('b');
    expect(secondTombstone.id).toBeUndefined();
  });

  test('stream error schedules reconnect instead of crashing', async () => {
    fakeZongjis[0].emit('error', new Error('server gone away'));
    expect(tailer.getStatus().reconnects).toBe(1);
    expect(tailer.getStatus().lastError).toBe('server gone away');
  });

  test('resumes from persisted GTID checkpoint when one exists', async () => {
    await BinlogTailerService.closeInstance(dbId);
    fakeZongjis.length = 0;

    const gtidMocks = makeMocks({
      clickhouse: {
        execute: vi.fn(async () => [{ filename: 'gtid:abc-uuid:1-100', position: 0 }]),
      },
    });
    const resumed = BinlogTailerService.getInstance(`${dbId}-gtid`, gtidMocks.mysql, gtidMocks.clickhouse, gtidMocks.syncService);
    await resumed.start();

    expect(fakeZongjis[0].startOptions.gtidSet).toBe('abc-uuid:1-100');
    expect(fakeZongjis[0].startOptions.startAtEnd).toBeUndefined();
    await BinlogTailerService.closeInstance(`${dbId}-gtid`);
  });
});
