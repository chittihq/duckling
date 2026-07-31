import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const execute = vi.hoisted(() => vi.fn());

vi.mock('../../database/clickhouse', () => ({
  default: { getInstance: () => ({ execute }) },
}));

import { logStorageReport } from '../storageReport';

let output: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  output = [];
  execute.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('startup storage report', () => {
  test('reports ClickHouse disk paths with human-readable capacity', async () => {
    // Shape taken from a real `SELECT ... FROM system.disks` response.
    execute.mockResolvedValue([
      { name: 'default', path: '/var/lib/clickhouse/', free_space: 67206742016, total_space: 322302373888 },
    ]);

    await logStorageReport('/app/data');
    const text = output.join('\n');

    expect(text).toContain('Storage locations');
    expect(text).toContain('/app/data');
    expect(text).toContain('ClickHouse "default": /var/lib/clickhouse/');
    expect(text).toContain('62.6 GB free of 300 GB');
  });

  test('lists every configured disk so a second (attached) disk is visible', async () => {
    execute.mockResolvedValue([
      { name: 'default', path: '/var/lib/clickhouse/', free_space: 1_000_000_000, total_space: 2_000_000_000 },
      { name: 'attached', path: '/mnt/volume/clickhouse/', free_space: 500_000_000_000, total_space: 512_000_000_000 },
    ]);

    await logStorageReport('/app/data');
    const text = output.join('\n');

    expect(text).toContain('ClickHouse "default"');
    expect(text).toContain('ClickHouse "attached": /mnt/volume/clickhouse/');
  });

  test('a ClickHouse that is not up yet degrades to a note, never throws', async () => {
    execute.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(logStorageReport('/app/data')).resolves.toBeUndefined();
    expect(output.join('\n')).toContain('ClickHouse: unavailable (connect ECONNREFUSED)');
  });

  test('handles a server that reports no disks', async () => {
    execute.mockResolvedValue([]);

    await logStorageReport('/app/data');
    expect(output.join('\n')).toContain('ClickHouse: no disks reported');
  });
});
