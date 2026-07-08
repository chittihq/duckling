import { describe, expect, it } from 'vitest';
import { pickSecret } from '../config';

/**
 * Turnkey secret precedence (config.ts): explicit env var > previously
 * persisted value > freshly generated. Env must never be marked generated
 * (so it is never written to disk).
 */
describe('pickSecret', () => {
  it('prefers a non-empty env value and does not mark it generated', () => {
    const r = pickSecret('from-env', 'from-disk', () => 'gen');
    expect(r).toEqual({ value: 'from-env', generated: false });
  });

  it('falls back to the persisted value when env is unset', () => {
    expect(pickSecret(undefined, 'from-disk', () => 'gen')).toEqual({ value: 'from-disk', generated: false });
    expect(pickSecret('', 'from-disk', () => 'gen')).toEqual({ value: 'from-disk', generated: false });
    expect(pickSecret('   ', 'from-disk', () => 'gen')).toEqual({ value: 'from-disk', generated: false });
  });

  it('generates when neither env nor persisted value is present', () => {
    const r = pickSecret(undefined, undefined, () => 'freshly-generated');
    expect(r).toEqual({ value: 'freshly-generated', generated: true });
    expect(pickSecret('', '  ', () => 'freshly-generated')).toEqual({ value: 'freshly-generated', generated: true });
  });
});
