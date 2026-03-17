import { describe, expect, test, vi } from 'vitest';
import DuckDBServer from '../server';

describe('DuckDBServer.getAllTableCounts', () => {
  test('counts tables sequentially to avoid flooding the shared DuckDB connection', async () => {
    let active = 0;
    let maxActive = 0;

    const duckdb = {
      getTables: vi.fn().mockResolvedValue(['users', 'orders', 'events']),
      getTableRowCount: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return 1;
      }),
    };

    const req = { duckdb } as any;
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any;

    const server = Object.create(DuckDBServer.prototype) as any;

    await server.getAllTableCounts(req, res);

    expect(maxActive).toBe(1);
    expect(res.json).toHaveBeenCalledWith({
      users: 1,
      orders: 1,
      events: 1,
    });
  });
});
