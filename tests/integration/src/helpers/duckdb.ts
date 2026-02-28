import { apiPost } from './api.js';
import { DB_ID } from './config.js';

export async function duckdbQuery(sql: string): Promise<any> {
  return apiPost(`/api/query?db=${DB_ID}`, { sql, database: 'duckdb' });
}

function parseDecimal({ value, scale }: { value: string; scale: number }): string {
  if (scale <= 0) return value;
  if (value.length <= scale) {
    return `0.${'0'.repeat(scale - value.length)}${value}`;
  }
  return `${value.slice(0, -scale)}.${value.slice(-scale)}`;
}

function extractScalar(data: any, field: string): string {
  const row = data?.result?.[0];
  if (!row) return 'null';
  const val = row[field];
  if (val === null || val === undefined) return 'null';
  // DuckDB DECIMAL object: { value: "...", scale: N }
  if (typeof val === 'object' && val.value !== undefined && val.scale !== undefined) {
    return parseDecimal(val);
  }
  return String(val);
}

/**
 * Lenient scalar query — returns "null" on any error.
 * Used for polling in waitForCdc and cases where null is expected.
 */
export async function duckdbScalar(sql: string, field: string): Promise<string> {
  try {
    const data = await duckdbQuery(sql);
    return extractScalar(data, field);
  } catch {
    return 'null';
  }
}

/**
 * Strict scalar query — throws on API error or empty response.
 * Used for assertions where a value is expected.
 */
export async function duckdbScalarStrict(sql: string, field: string): Promise<string> {
  const data = await duckdbQuery(sql);
  return extractScalar(data, field);
}

/**
 * Strip trailing zeros after decimal point, then trailing dot.
 * "1500.50" → "1500.5", "100.00" → "100", "0.10" → "0.1"
 */
export function normalizeDecimal(val: string): string {
  if (!val.includes('.')) return val;
  return val.replace(/\.(\d*[1-9])0+$/, '.$1').replace(/\.0*$/, '');
}
