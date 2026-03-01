import * as crypto from 'crypto';

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_FOUND_ROWS = 0x00000002;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_NO_SCHEMA = 0x00000010;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_ATTRS = 0x00100000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;

export function sha1(...buffers: Buffer[]): Buffer {
  const hash = crypto.createHash('sha1');
  for (const buf of buffers) hash.update(buf);
  return hash.digest();
}

export function xor(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) result[i] = a[i] ^ b[i];
  return result;
}

export function doubleSha1(password: string): Buffer {
  return sha1(sha1(Buffer.from(password)));
}

export function verifyToken(
  publicSeed1: Buffer,
  publicSeed2: Buffer,
  token: Buffer,
  doubleSha: Buffer,
): boolean {
  const seed1 = publicSeed1.slice(0, 8);
  const seed2 = publicSeed2.slice(0, 12);
  const hashStage1 = xor(token, sha1(seed1, seed2, doubleSha));
  const candidateHash2 = sha1(hashStage1);
  return candidateHash2.compare(doubleSha) === 0;
}

export function formatCapabilityFlags(flags: number): string {
  return `0x${flags.toString(16).padStart(8, '0')}`;
}

export function describeCapabilityFlags(flags: number): string[] {
  if (!flags) return [];

  const knownFlags: Array<[string, number]> = [
    ['LONG_PASSWORD', CLIENT_LONG_PASSWORD],
    ['FOUND_ROWS', CLIENT_FOUND_ROWS],
    ['LONG_FLAG', CLIENT_LONG_FLAG],
    ['CONNECT_WITH_DB', CLIENT_CONNECT_WITH_DB],
    ['NO_SCHEMA', CLIENT_NO_SCHEMA],
    ['PROTOCOL_41', CLIENT_PROTOCOL_41],
    ['TRANSACTIONS', CLIENT_TRANSACTIONS],
    ['SECURE_CONNECTION', CLIENT_SECURE_CONNECTION],
    ['MULTI_RESULTS', CLIENT_MULTI_RESULTS],
    ['PLUGIN_AUTH', CLIENT_PLUGIN_AUTH],
    ['CONNECT_ATTRS', CLIENT_CONNECT_ATTRS],
    ['PLUGIN_AUTH_LENENC_CLIENT_DATA', CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA],
  ];

  return knownFlags
    .filter(([, value]) => (flags & value) !== 0)
    .map(([name]) => name);
}

export function compactSqlForLog(sql: string, maxLen = 300): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.substring(0, maxLen)}...`;
}
