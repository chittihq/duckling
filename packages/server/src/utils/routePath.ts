/**
 * Canonical path for security decisions (auth gating, scope enforcement,
 * rate-limit classification).
 *
 * Express routes with `caseSensitive: false` and `strict: false` by default,
 * so `/API/QUERY` and `/api/login/` reach the same handlers as their canonical
 * lowercase, non-trailing-slash forms. Any middleware that decides "does this
 * path require auth?" with a case-sensitive exact/prefix comparison therefore
 * disagrees with the router — and the request slips through unauthenticated
 * and unmetered.
 *
 * Normalizing to exactly what Express's matcher considers equivalent keeps the
 * two in agreement. Erring toward over-matching here is safe (a request gets
 * authenticated or metered that didn't strictly need to be); under-matching is
 * the vulnerability.
 */
export function normalizeRoutePath(rawPath: string): string {
  if (!rawPath) {
    return '/';
  }

  // Strip trailing slashes (non-strict routing treats them as equivalent),
  // keeping the root path intact.
  let path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  if (path === '') {
    path = '/';
  }

  // Case-insensitive routing: compare in lowercase.
  return path.toLowerCase();
}
