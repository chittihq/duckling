import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison for secrets (e.g. the global API key).
 *
 * A plain `a === b` bails on the first differing character, leaking timing that
 * can be used to recover a secret character-by-character (#71). We hash both
 * sides to a fixed 32-byte digest first — so `timingSafeEqual` never sees
 * mismatched lengths (which would throw and itself leak length) — then compare
 * the digests in constant time. Non-string inputs never match.
 */
export function timingSafeEqualStr(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
