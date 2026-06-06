import { describe, expect, test } from 'vitest';
import { resolveClientIp, normalizeIp } from '../clientIp';

/**
 * Regression for #66: X-Forwarded-For must not be trusted unless we sit behind
 * a known number of proxies, and even then a client can't forge its IP by
 * prepending entries.
 */
describe('normalizeIp', () => {
  test('strips IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp(undefined)).toBe('');
  });
});

describe('resolveClientIp', () => {
  test('trustedHops=0 ignores X-Forwarded-For entirely (no spoofing)', () => {
    // Client tries to forge an IP via the header; we must use the socket peer.
    expect(resolveClientIp('9.9.9.9', '10.0.0.5', 0)).toBe('10.0.0.5');
    expect(resolveClientIp(['9.9.9.9'], '10.0.0.5', 0)).toBe('10.0.0.5');
  });

  test('trustedHops=0 with no header uses the socket peer', () => {
    expect(resolveClientIp(undefined, '::ffff:198.51.100.2', 0)).toBe('198.51.100.2');
    expect(resolveClientIp(undefined, undefined, 0)).toBe('unknown');
  });

  test('single trusted proxy: real client is the rightmost XFF entry', () => {
    // nginx ($proxy_add_x_forwarded_for) appends the real client last.
    expect(resolveClientIp('203.0.113.9', '10.0.0.5', 1)).toBe('203.0.113.9');
  });

  test('single trusted proxy: prepended spoof entries are ignored', () => {
    // Client sends "1.2.3.4" (spoof); nginx appends the real client.
    expect(resolveClientIp('1.2.3.4, 203.0.113.9', '10.0.0.5', 1)).toBe('203.0.113.9');
    // Even a long forged chain can't escape — the real client stays rightmost.
    expect(resolveClientIp('a, b, c, d, 203.0.113.9', '10.0.0.5', 1)).toBe('203.0.113.9');
  });

  test('two trusted proxies: client is second from the right', () => {
    // client -> proxy1 -> proxy2 -> app; XFF = [client, proxy1], peer = proxy2.
    expect(resolveClientIp('203.0.113.9, 10.0.0.1', '10.0.0.2', 2)).toBe('203.0.113.9');
  });

  test('chain shorter than the hop count falls back to the socket peer', () => {
    // Misconfigured (claims 2 hops but only 1 entry) -> safe fallback.
    expect(resolveClientIp('203.0.113.9', '10.0.0.5', 2)).toBe('10.0.0.5');
  });

  test('empty/whitespace header with trust falls back to the socket peer', () => {
    expect(resolveClientIp('   ', '10.0.0.5', 1)).toBe('10.0.0.5');
    expect(resolveClientIp(undefined, '10.0.0.5', 1)).toBe('10.0.0.5');
  });

  test('normalizes the selected XFF entry', () => {
    expect(resolveClientIp('::ffff:203.0.113.9', '10.0.0.5', 1)).toBe('203.0.113.9');
  });
});
