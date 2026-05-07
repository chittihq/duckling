import { apiPost } from './api.js';
import { DB_ID } from './config.js';

export async function clickhouseQuery(sql: string): Promise<any> {
  return apiPost(`/api/query?db=${DB_ID}`, { sql, database: 'clickhouse' });
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
  if (typeof val === 'object' && val.value !== undefined && val.scale !== undefined) {
    return parseDecimal(val);
  }
  const stringValue = String(val);
  if (/^\d{4}-\d{2}-\d{2} 00:00:00(?:\.0+)?$/.test(stringValue)) {
    return stringValue.slice(0, 10);
  }
  return stringValue;
}

export async function clickhouseScalar(sql: string, field: string): Promise<string> {
  try {
    const data = await clickhouseQuery(sql);
    return extractScalar(data, field);
  } catch {
    return 'null';
  }
}

export async function clickhouseScalarStrict(sql: string, field: string): Promise<string> {
  const data = await clickhouseQuery(sql);
  return extractScalar(data, field);
}

export function normalizeDecimal(val: string): string {
  if (!val.includes('.')) return val;
  return val.replace(/\.(\d*[1-9])0+$/, '.$1').replace(/\.0*$/, '');
}
