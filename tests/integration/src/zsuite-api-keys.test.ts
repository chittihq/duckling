/**
 * Suite Z3: per-database API keys — comprehensive end-to-end coverage.
 *
 * Exercises the live server's per-database API key feature:
 *   - CRUD + validation of keys (admin only)
 *   - one-time secret reveal; hashes never leave the server
 *   - authentication of a scoped key on its own database's data plane
 *   - scope isolation: 403 on other databases (?db=) and on the entire
 *     /api/databases/:id control plane (incl. minting more keys)
 *   - lifecycle effects take hold immediately via the in-memory index:
 *     disable / re-enable / revoke / expiry
 *   - independence of multiple keys; the global key stays unscoped superuser
 *
 * Runs last alphabetically (zsuite-*) and only mints keys on the existing
 * DB_ID, cleaning each up, so it does not disturb earlier suites.
 */
import { describe, test, expect, afterAll } from 'vitest';
import { API_URL, API_KEY, DB_ID } from './helpers/config.js';

const ADMIN_JSON = { Authorization: API_KEY, 'Content-Type': 'application/json' };
const ADMIN = { Authorization: API_KEY };
const OTHER_DB = 'some-other-db-xyz';

// Track every key id we mint so we can revoke leftovers even if a test fails.
const mintedKeyIds = new Set<string>();

type MintResult = { secret: string; id: string; apiKey: any };

async function mintKey(name: string, expiresAt?: string): Promise<MintResult> {
  const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
    method: 'POST',
    headers: ADMIN_JSON,
    body: JSON.stringify(expiresAt ? { name, expiresAt } : { name }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  mintedKeyIds.add(body.apiKey.id);
  return { secret: body.secret, id: body.apiKey.id, apiKey: body.apiKey };
}

function bearer(secret: string, json = false): Record<string, string> {
  return json ? { Authorization: secret, 'Content-Type': 'application/json' } : { Authorization: secret };
}

afterAll(async () => {
  for (const id of mintedKeyIds) {
    await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'DELETE',
      headers: ADMIN,
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
describe('Z3.1 key CRUD + validation (admin)', () => {
  test('POST mints a key: secret returned once, sane metadata, no hash', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: ADMIN_JSON,
      body: JSON.stringify({ name: 'crud token' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    mintedKeyIds.add(body.apiKey.id);

    expect(body.success).toBe(true);
    expect(body.secret).toMatch(/^dk_/);
    expect(body.apiKey.id).toMatch(/^key_/);
    expect(body.apiKey.name).toBe('crud token');
    expect(body.apiKey.enabled).toBe(true);
    expect(body.apiKey.last4).toBe(body.secret.slice(-4));
    expect(body.apiKey.hash).toBeUndefined();
    expect(body.apiKey.lastUsedAt).toBeUndefined();
  });

  test('POST without a name is 400', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: ADMIN_JSON,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('POST with a malformed expiresAt is 400', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: ADMIN_JSON,
      body: JSON.stringify({ name: 'bad expiry', expiresAt: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST to an unknown database is 404', async () => {
    const res = await fetch(`${API_URL}/api/databases/${OTHER_DB}/api-keys`, {
      method: 'POST',
      headers: ADMIN_JSON,
      body: JSON.stringify({ name: 'ghost' }),
    });
    expect(res.status).toBe(404);
  });

  test('GET list never includes the hash and reflects new keys', async () => {
    const { id } = await mintKey('listed token');
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.json();
    const k = body.apiKeys.find((x: any) => x.id === id);
    expect(k).toBeTruthy();
    expect(k.hash).toBeUndefined();
    expect(typeof k.last4).toBe('string');
  });

  test('PATCH renames a key and the change is listed', async () => {
    const { id } = await mintKey('old name');
    const patch = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ name: 'new name' }),
    });
    expect(patch.status).toBe(200);
    const list = await (await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, { headers: ADMIN })).json();
    expect(list.apiKeys.find((x: any) => x.id === id).name).toBe('new name');
  });

  test('PATCH with a non-boolean enabled is 400', async () => {
    const { id } = await mintKey('patch-validate');
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH / DELETE on an unknown keyId are 404', async () => {
    const patch = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/key_does_not_exist`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(404);
    const del = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/key_does_not_exist`, {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(del.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('Z3.2 authentication edges', () => {
  test('a request with no Authorization header is 401', async () => {
    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`);
    expect(res.status).toBe(401);
  });

  test('a bogus dk_ token is 401', async () => {
    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, {
      headers: { Authorization: 'dk_not_a_real_key_value' },
    });
    expect(res.status).toBe(401);
  });

  test('a scoped key authenticates a data-plane read on its own database', async () => {
    const { secret } = await mintKey('reader');
    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) });
    expect(res.status).toBe(200);
  });

  test('a scoped key can run a query on its own database', async () => {
    const { secret } = await mintKey('querier');
    const res = await fetch(`${API_URL}/api/query?db=${DB_ID}`, {
      method: 'POST',
      headers: bearer(secret, true),
      body: JSON.stringify({ sql: 'SELECT 1 AS one' }),
    });
    expect(res.status).toBe(200);
  });

  test('a scoped key with no ?db defaults to its own database (not 404/default)', async () => {
    const { secret } = await mintKey('defaulter');
    const res = await fetch(`${API_URL}/api/tables`, { headers: bearer(secret) });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('Z3.3 scope isolation — control plane is admin-only', () => {
  let secret = '';
  test('mint the scoped key used by this group', async () => {
    secret = (await mintKey('scoped-isolation')).secret;
    expect(secret).toMatch(/^dk_/);
  });

  test('403 on another database via ?db=', async () => {
    const res = await fetch(`${API_URL}/api/tables?db=${OTHER_DB}`, { headers: bearer(secret) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/scoped to database/);
  });

  test('403 on a data-plane route with a mismatched ?db=', async () => {
    const res = await fetch(`${API_URL}/sync/status?db=${OTHER_DB}`, { headers: bearer(secret) });
    expect(res.status).toBe(403);
  });

  test.each([
    ['GET', '/replication-mode'],
    ['GET', '/s3-backup'],
    ['GET', '/backups'],
    ['GET', '/bootstrap/status'],
  ])('403 on own-db control plane: %s /api/databases/:id%s', async (method, suffix) => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}${suffix}`, { method, headers: bearer(secret) });
    expect(res.status).toBe(403);
  });

  test('403 minting another key with a scoped key (no escalation)', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: bearer(secret, true),
      body: JSON.stringify({ name: 'escalation' }),
    });
    expect(res.status).toBe(403);
  });

  test('403 editing the database record', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}`, {
      method: 'PUT',
      headers: bearer(secret, true),
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(res.status).toBe(403);
  });

  test('403 deleting the database', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}`, { method: 'DELETE', headers: bearer(secret) });
    expect(res.status).toBe(403);
  });

  test('GET /api/databases is filtered to only the scoped database', async () => {
    const res = await fetch(`${API_URL}/api/databases`, { headers: bearer(secret) });
    expect(res.status).toBe(200);
    expect((await res.json()).databases.map((d: any) => d.id)).toEqual([DB_ID]);
  });
});

// ---------------------------------------------------------------------------
describe('Z3.4 scope — data plane on own database is allowed', () => {
  let secret = '';
  test('mint the scoped key used by this group', async () => {
    secret = (await mintKey('scoped-dataplane')).secret;
  });

  test.each([
    '/health',
    '/status',
    '/sync/status',
    '/cdc/status',
    '/automation/status',
    '/api/tables/counts/all',
  ])('200 on own-db data-plane route %s', async (route) => {
    const res = await fetch(`${API_URL}${route}?db=${DB_ID}`, { headers: bearer(secret) });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('Z3.5 lifecycle takes effect immediately', () => {
  test('disable revokes access, re-enable restores it', async () => {
    const { secret, id } = await mintKey('toggle');
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(200);

    const off = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(401);

    const on = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(200);
  });

  test('a key created already-expired is rejected but still visible to admin', async () => {
    const { secret, id } = await mintKey('born-expired', '2000-01-01T00:00:00.000Z');
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(401);
    const list = await (await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, { headers: ADMIN })).json();
    expect(list.apiKeys.find((x: any) => x.id === id)).toBeTruthy();
  });

  test('PATCHing expiresAt into the past revokes; clearing it restores', async () => {
    const { secret, id } = await mintKey('expiry-toggle');
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(200);

    await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    });
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(401);

    await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, {
      method: 'PATCH',
      headers: ADMIN_JSON,
      body: JSON.stringify({ expiresAt: null }),
    });
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(200);
  });

  test('revoking a key makes it 401 immediately', async () => {
    const { secret, id } = await mintKey('revoke-me');
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(200);
    const del = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${id}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);
    mintedKeyIds.delete(id);
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) })).status).toBe(401);
  });

  test('lastUsedAt is populated after first use', async () => {
    const { secret, id } = await mintKey('touch-me');
    await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(secret) });
    const list = await (await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, { headers: ADMIN })).json();
    expect(list.apiKeys.find((x: any) => x.id === id).lastUsedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('Z3.6 independence + global key', () => {
  test('two keys are independent: revoking one leaves the other working', async () => {
    const a = await mintKey('independent-a');
    const b = await mintKey('independent-b');
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(a.secret) })).status).toBe(200);
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(b.secret) })).status).toBe(200);

    await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${a.id}`, { method: 'DELETE', headers: ADMIN });
    mintedKeyIds.delete(a.id);

    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(a.secret) })).status).toBe(401);
    expect((await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: bearer(b.secret) })).status).toBe(200);
  });

  test('the global key remains an unscoped superuser (reaches the control plane)', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/s3-backup`, { headers: ADMIN });
    expect(res.status).toBe(200); // not 403 — admin is never scoped
  });

  test('the global key sees all databases, never filtered', async () => {
    const res = await fetch(`${API_URL}/api/databases`, { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.databases.some((d: any) => d.id === DB_ID)).toBe(true);
    // And no hashes leak through the list path either.
    for (const d of body.databases) {
      for (const k of d.apiKeys ?? []) expect(k.hash).toBeUndefined();
    }
  });
});
