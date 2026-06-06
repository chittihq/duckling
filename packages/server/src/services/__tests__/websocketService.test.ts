import { describe, expect, test } from 'vitest';
import { WebSocketService } from '../websocketService';

/**
 * getClientIp is proxy-aware after #66. With the default config (no
 * TRUST_PROXY / trustProxyHops=0) it must ignore the spoofable X-Forwarded-For
 * header and use the direct socket peer. Hop-based extraction is covered in
 * utils/__tests__/clientIp.test.ts.
 */
describe('WebSocketService.getClientIp', () => {
  test('ignores x-forwarded-for by default (no trusted proxy)', () => {
    const service = Object.create(WebSocketService.prototype) as any;
    const req = {
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.1.4', // attacker-supplied
      },
      socket: {
        remoteAddress: '::ffff:10.0.1.4',
      },
    } as any;

    // Must be the socket peer (normalized), NOT the forged header value.
    expect(service.getClientIp(req)).toBe('10.0.1.4');
  });

  test('normalizes the socket remoteAddress when no header is present', () => {
    const service = Object.create(WebSocketService.prototype) as any;
    const req = {
      headers: {},
      socket: {
        remoteAddress: '::ffff:10.0.1.4',
      },
    } as any;

    expect(service.getClientIp(req)).toBe('10.0.1.4');
  });
});
