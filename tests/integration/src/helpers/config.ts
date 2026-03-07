import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export const API_URL = process.env.DUCKLING_TEST_API_URL || 'http://localhost:3002';
export const API_KEY = process.env.DUCKLING_TEST_API_KEY || 'integration-test-key';
export const DB_ID = process.env.DUCKLING_TEST_DB_ID || 'integration';
export const WS_URL = (() => {
  const url = new URL(API_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
})();

export const TIMEOUT_STARTUP = Number(process.env.DUCKLING_TEST_TIMEOUT_STARTUP || 180) * 1000;
export const TIMEOUT_CDC = Number(process.env.DUCKLING_TEST_TIMEOUT_CDC || 30) * 1000;
export const TIMEOUT_CDC_START = Number(process.env.DUCKLING_TEST_TIMEOUT_CDC_START || 15) * 1000;
export const SDK_REGISTRY_VERSION = process.env.DUCKLING_TEST_SDK_REGISTRY_VERSION || '';
export const SDK_REGISTRY_URL = process.env.DUCKLING_TEST_SDK_REGISTRY_URL || 'https://registry.npmjs.org';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const INTEGRATION_DIR = resolve(__dirname, '..', '..');
