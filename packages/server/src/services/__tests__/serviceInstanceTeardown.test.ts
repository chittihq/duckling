import { describe, expect, test } from 'vitest';
import CdcCompatibilityService from '../cdcCompatibilityService';
import ClickHouseAutomationService from '../clickhouseAutomationService';

/**
 * Regression for #70: deleting a database must stop its per-database
 * background services and drop the cached instance, not just close the
 * ClickHouse connection. These tests assert the static closeInstance()
 * teardown actually removes the instance from the singleton map.
 *
 * The constructors only store references (no timers), so `{} as any` deps are
 * safe — closeInstance just calls the null-safe stop() and deletes the entry.
 */
const fake = {} as any;

describe('CdcCompatibilityService.closeInstance (#70)', () => {
  test('stops and removes the cached instance', async () => {
    const a = CdcCompatibilityService.getInstance('teardown-cdc', fake, fake, fake);
    await CdcCompatibilityService.closeInstance('teardown-cdc');
    const b = CdcCompatibilityService.getInstance('teardown-cdc', fake, fake, fake);
    expect(b).not.toBe(a); // a fresh instance proves the old one was evicted
    expect(b.getStatus().isRunning).toBe(false);
    await CdcCompatibilityService.closeInstance('teardown-cdc');
  });

  test('is a no-op for an unknown database', async () => {
    await expect(CdcCompatibilityService.closeInstance('never-existed')).resolves.toBeUndefined();
  });
});

describe('ClickHouseAutomationService.closeInstance (#70)', () => {
  test('stops and removes the cached instance', () => {
    const a = ClickHouseAutomationService.getInstance('teardown-auto', fake, fake, fake);
    ClickHouseAutomationService.closeInstance('teardown-auto');
    const b = ClickHouseAutomationService.getInstance('teardown-auto', fake, fake, fake);
    expect(b).not.toBe(a);
    ClickHouseAutomationService.closeInstance('teardown-auto');
  });

  test('is a no-op for an unknown database', () => {
    expect(() => ClickHouseAutomationService.closeInstance('never-existed')).not.toThrow();
  });
});
