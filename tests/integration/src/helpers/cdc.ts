import { apiPost, apiGet } from './api.js';
import { DB_ID, TIMEOUT_CDC, TIMEOUT_CDC_START } from './config.js';
import { clickhouseScalar } from './clickhouse.js';

export async function cdcStart(): Promise<any> {
  try {
    return await apiPost(`/cdc/start?db=${DB_ID}`);
  } catch {
    return {};
  }
}

export async function cdcStop(): Promise<any> {
  try {
    return await apiPost(`/cdc/stop?db=${DB_ID}`);
  } catch {
    return {};
  }
}

export async function cdcStatus(): Promise<any> {
  try {
    return await apiGet(`/cdc/status?db=${DB_ID}`);
  } catch {
    return {};
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForCdcRunning(timeout = TIMEOUT_CDC_START): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const resp = await cdcStatus();
    if (resp?.status?.isRunning === true) return true;
    await sleep(1000);
  }
  return false;
}

export async function waitForCdc(
  sql: string,
  field: string,
  expected: string,
  timeout = TIMEOUT_CDC,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const actual = await clickhouseScalar(sql, field);
    if (actual === expected) return true;
    await sleep(1000);
  }
  return false;
}
