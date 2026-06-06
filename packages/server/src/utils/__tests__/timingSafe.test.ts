import { describe, expect, test } from 'vitest';
import { timingSafeEqualStr } from '../timingSafe';

/** Regression for #71: constant-time API-key comparison. */
describe('timingSafeEqualStr', () => {
  test('returns true only for an exact match', () => {
    expect(timingSafeEqualStr('s3cr3t-key', 's3cr3t-key')).toBe(true);
    expect(timingSafeEqualStr('s3cr3t-key', 's3cr3t-keX')).toBe(false);
  });

  test('mismatched lengths do not throw and never match', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
    expect(timingSafeEqualStr('a-much-longer-secret', 'short')).toBe(false);
  });

  test('empty strings match each other but not a non-empty secret', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
    expect(timingSafeEqualStr('', 'secret')).toBe(false);
  });

  test('null / undefined inputs never match', () => {
    expect(timingSafeEqualStr(undefined, 'secret')).toBe(false);
    expect(timingSafeEqualStr('secret', undefined)).toBe(false);
    expect(timingSafeEqualStr(null, null)).toBe(false);
  });
});
