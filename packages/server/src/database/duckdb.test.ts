import { describe, test, expect, vi } from 'vitest';
import DuckDBConnection from './duckdb';

describe('DuckDBConnection.logSync', () => {
  test('includes watermark_before and watermark_after in sync log insert', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const connection = Object.create(DuckDBConnection.prototype) as any;
    connection.run = run;

    await connection.logSync(
      'User',
      'incremental',
      10,
      42,
      'success',
      null,
      '{"lastProcessedTimestamp":"2026-01-01T00:00:00.000Z"}',
      '{"lastProcessedTimestamp":"2026-01-01T00:01:00.000Z"}'
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('watermark_before, watermark_after');
    expect(run.mock.calls[0][1]).toEqual([
      'User',
      'incremental',
      10,
      42,
      'success',
      null,
      '{"lastProcessedTimestamp":"2026-01-01T00:00:00.000Z"}',
      '{"lastProcessedTimestamp":"2026-01-01T00:01:00.000Z"}'
    ]);
  });
});
