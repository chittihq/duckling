import { beforeEach, describe, expect, test, vi } from 'vitest';

const { queryMock, commandMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async () => ({ json: async () => [] as unknown })),
  commandMock: vi.fn(async () => ({})),
}));

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => ({
    query: queryMock,
    command: commandMock,
    insert: vi.fn(),
    ping: vi.fn(async () => ({ success: true })),
    close: vi.fn(),
  })),
}));

vi.mock('../../logger', () => ({
  __esModule: true,
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  __esModule: true,
  default: {
    clickhouse: {
      url: 'http://localhost:8123',
      username: 'default',
      password: '',
      database: 'testdb',
      finalReads: true,
    },
  },
}));

import ClickHouseConnection from '../clickhouse';
import config from '../../config';

describe('ClickHouse final-read consistency', () => {
  beforeEach(() => {
    queryMock.mockClear();
    commandMock.mockClear();
    (config as any).clickhouse.finalReads = true;
  });

  test('execute() applies final=1 so ReplacingMergeTree reads are deduplicated', async () => {
    const ch = ClickHouseConnection.getInstance('final-a', 'testdb');
    await ch.execute('SELECT * FROM users');
    const opts = queryMock.mock.calls.at(-1)![0] as any;
    expect(opts.clickhouse_settings).toEqual({ final: 1 });
  });

  test('executeWithMetadata() (MySQL wire path) applies final=1', async () => {
    const ch = ClickHouseConnection.getInstance('final-b', 'testdb');
    await ch.executeWithMetadata('SELECT * FROM users');
    const opts = queryMock.mock.calls.at(-1)![0] as any;
    expect(opts.clickhouse_settings).toEqual({ final: 1 });
  });

  test('CLICKHOUSE_FINAL_READS=false opt-out omits the setting', async () => {
    (config as any).clickhouse.finalReads = false;
    const ch = ClickHouseConnection.getInstance('final-c', 'testdb');
    await ch.execute('SELECT * FROM users');
    const opts = queryMock.mock.calls.at(-1)![0] as any;
    expect(opts.clickhouse_settings).toEqual({});
  });

  test('run() (DDL/commands) never carries the read setting', async () => {
    const ch = ClickHouseConnection.getInstance('final-d', 'testdb');
    await ch.run('OPTIMIZE TABLE x FINAL');
    const opts = commandMock.mock.calls.at(-1)![0] as any;
    expect(opts.clickhouse_settings).toEqual({ wait_end_of_query: 1 });
  });
});
