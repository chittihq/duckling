import { describe, expect, test } from 'vitest';
import { WebSocketService } from '../websocketService';

describe('WebSocketService.getClientIp', () => {
  test('prefers the first x-forwarded-for entry', () => {
    const service = Object.create(WebSocketService.prototype) as any;
    const req = {
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.1.4',
      },
      socket: {
        remoteAddress: '::ffff:10.0.1.4',
      },
    } as any;

    expect(service.getClientIp(req)).toBe('203.0.113.5');
  });

  test('falls back to socket remoteAddress', () => {
    const service = Object.create(WebSocketService.prototype) as any;
    const req = {
      headers: {},
      socket: {
        remoteAddress: '::ffff:10.0.1.4',
      },
    } as any;

    expect(service.getClientIp(req)).toBe('::ffff:10.0.1.4');
  });
});
