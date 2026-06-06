/**
 * Secure client-IP resolution for raw-socket paths (e.g. the WebSocket server)
 * that don't go through Express's proxy-aware `req.ip`.
 *
 * X-Forwarded-For is client-controllable, so it must only be consulted when we
 * actually sit behind a known number of trusted proxies. The matching HTTP
 * behaviour comes from `app.set('trust proxy', ...)`; this mirrors it for the
 * WS handshake using the same hop count.
 */

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:1.2.3.4` reads as `1.2.3.4`. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return '';
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/**
 * Resolve the real client IP.
 *
 * @param forwardedFor       the X-Forwarded-For header value (string or array)
 * @param socketRemoteAddress the direct TCP peer (the proxy, when fronted)
 * @param trustedHops        number of proxy hops we control (0 = trust none)
 *
 * With `trustedHops <= 0` the header is ignored entirely and the direct socket
 * peer is returned — no spoofing is possible. With N trusted hops, the rightmost
 * N entries of the chain were appended by proxies we control; the real client is
 * the entry immediately to their left (`chain.length - trustedHops`). Any forged
 * entries a client prepends sit further left and are never selected. A chain
 * shorter than the configured hop count falls back to the socket peer.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  socketRemoteAddress: string | undefined,
  trustedHops: number,
): string {
  const direct = normalizeIp(socketRemoteAddress) || 'unknown';
  if (trustedHops <= 0) return direct;

  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length === 0) return direct;

  const idx = chain.length - trustedHops;
  if (idx < 0 || idx >= chain.length) return direct;
  return normalizeIp(chain[idx]) || direct;
}
