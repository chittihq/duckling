import { describe, test, expect, vi, afterEach } from 'vitest';
import DuckDBConnection from '../duckdb';

describe('DuckDBConnection.checkpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('propagates checkpoint failures', async () => {
    const connection = Object.create((DuckDBConnection as any).prototype);
    connection.run = vi.fn().mockRejectedValue(new Error('checkpoint failed'));

    await expect(connection.checkpoint()).rejects.toThrow('checkpoint failed');
  });
});
