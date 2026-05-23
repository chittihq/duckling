import { API_URL, API_KEY } from './config.js';

export async function apiPost(path: string, body?: any): Promise<any> {
  const url = `${API_URL}${path}`;
  const opts: RequestInit = {
    method: 'POST',
    headers: {
      'Authorization': API_KEY,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(300_000),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

export async function apiGet(path: string): Promise<any> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': API_KEY,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

export async function apiPut(path: string, body?: any): Promise<any> {
  const url = `${API_URL}${path}`;
  const opts: RequestInit = {
    method: 'PUT',
    headers: {
      'Authorization': API_KEY,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

export async function apiDelete(path: string): Promise<any> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': API_KEY,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DELETE ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}
