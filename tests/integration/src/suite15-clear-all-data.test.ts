import { describe, expect, test } from 'vitest';
import { apiDelete } from './helpers/api.js';
import { DB_ID } from './helpers/config.js';
import { clickhouseQuery, clickhouseScalarStrict } from './helpers/clickhouse.js';
import { triggerFullSync } from './helpers/sync.js';

describe('Suite 15: Clear All Data', () => {
  test('legacy clear-all route clears replicated tables and reinitializes metadata', async () => {
    await triggerFullSync();

    const usersBefore = Number(
      await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt'),
    );
    expect(usersBefore).toBeGreaterThan(0);

    const result = await apiDelete(`/storage/clear-all?db=${DB_ID}`);
    expect(result.success).toBe(true);
    expect(Number(result.tablesDropped)).toBeGreaterThan(0);

    const tablesResponse = await clickhouseQuery(
      "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name",
    );
    const tableNames = (tablesResponse.result ?? []).map((row: Record<string, unknown>) => String(row.name));
    const watermarkCount = Number(
      await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM appender_watermarks', 'cnt'),
    );

    expect(tableNames).toEqual(expect.arrayContaining(['appender_watermarks', 'sync_log']));
    expect(tableNames).not.toContain('users_with_timestamps');
    expect(tableNames).not.toContain('products_simple');
    expect(watermarkCount).toBe(0);
  }, 120_000);
});
