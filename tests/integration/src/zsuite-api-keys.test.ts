/**
 * Suite Z3: per-database API keys + scope isolation, end-to-end.
 *
 * Verifies the data-plane-only, single-database scoping of per-database API
 * keys against the live server:
 *   - admin mints a key for DB_ID; the secret is returned exactly once
 *   - the scoped key authenticates data-plane calls against its own database
 *   - the scoped key is 403'd on another database (?db=) and on the entire
 *     /api/databases/:id control plane (incl. minting more keys)
 *   - GET /api/databases is filtered to just the scoped database
 *   - disable / re-enable / revoke take effect immediately (in-memory index)
 *   - key hashes never appear in any response
 *
 * Runs last alphabetically (zsuite-*) and only mints keys on the existing
 * DB_ID, so it doesn't disturb earlier suites.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { API_URL, API_KEY, DB_ID } from './helpers/config.js';

const ADMIN = { Authorization: API_KEY, 'Content-Type': 'application/json' };
const OTHER_DB = 'some-other-db-xyz';

let secret: string | null = null;
let keyId: string | null = null;

function scoped(extra: Record<string, string> = {}) {
  return { Authorization: secret as string, ...extra };
}

describe('Suite Z3: per-database API keys + scope isolation', () => {
  beforeAll(() => {
    expect(API_URL).toBeTruthy();
  });

  test('admin mints a key; secret returned once, hash never exposed', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ name: 'e2e scoped token' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.secret).toBe('string');
    expect(body.secret).toMatch(/^dk_/);
    expect(body.apiKey?.hash).toBeUndefined();
    expect(body.apiKey?.last4).toBe(body.secret.slice(-4));
    secret = body.secret;
    keyId = body.apiKey.id;
  });

  test('listing keys (admin) never includes the hash', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, { headers: { Authorization: API_KEY } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const k = body.apiKeys.find((x: any) => x.id === keyId);
    expect(k).toBeTruthy();
    expect(k.hash).toBeUndefined();
  });

  test('scoped key authenticates a data-plane read on its own database', async () => {
    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: scoped() });
    expect(res.status).toBe(200);
  });

  test('scoped key can run a query on its own database', async () => {
    const res = await fetch(`${API_URL}/api/query?db=${DB_ID}`, {
      method: 'POST',
      headers: scoped({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sql: 'SELECT 1 AS one' }),
    });
    expect(res.status).toBe(200);
  });

  test('scoped key with no ?db defaults to its own database (not 404)', async () => {
    const res = await fetch(`${API_URL}/api/tables`, { headers: scoped() });
    expect(res.status).toBe(200);
  });

  test('scoped key is 403 on another database via ?db=', async () => {
    const res = await fetch(`${API_URL}/api/tables?db=${OTHER_DB}`, { headers: scoped() });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/scoped to database/);
  });

  test('GET /api/databases is filtered to just the scoped database', async () => {
    const res = await fetch(`${API_URL}/api/databases`, { headers: scoped() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.databases.map((d: any) => d.id)).toEqual([DB_ID]);
  });

  test('scoped key is 403 on the control plane (cannot mint more keys)', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys`, {
      method: 'POST',
      headers: scoped({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'escalation attempt' }),
    });
    expect(res.status).toBe(403);
  });

  test('scoped key is 403 trying to delete its own database', async () => {
    const res = await fetch(`${API_URL}/api/databases/${DB_ID}`, { method: 'DELETE', headers: scoped() });
    expect(res.status).toBe(403);
  });

  test('disabling the key (admin) revokes access immediately', async () => {
    const patch = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${keyId}`, {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: scoped() });
    expect(res.status).toBe(401);
  });

  test('re-enabling the key restores access', async () => {
    const patch = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${keyId}`, {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(200);

    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: scoped() });
    expect(res.status).toBe(200);
  });

  test('revoking the key (admin) makes it 401; cleanup', async () => {
    const del = await fetch(`${API_URL}/api/databases/${DB_ID}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: API_KEY },
    });
    expect(del.status).toBe(200);

    const res = await fetch(`${API_URL}/api/tables?db=${DB_ID}`, { headers: scoped() });
    expect(res.status).toBe(401);
  });
});
