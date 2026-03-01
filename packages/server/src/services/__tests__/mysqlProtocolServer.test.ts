import { describe, test, expect } from 'vitest';
import { __testHelpers } from '../mysqlProtocolServer';

const {
  sha1,
  xor,
  doubleSha1,
  verifyToken,
  formatCapabilityFlags,
  describeCapabilityFlags,
  compactSqlForLog,
} = __testHelpers;

// =====================================================================
// Crypto helpers (MySQL AUTH_41)
// =====================================================================

describe('auth_41 crypto helpers', () => {
  describe('sha1', () => {
    test('matches known SHA-1 hash', () => {
      // SHA-1 of empty string is da39a3ee5e6b4b0d3255bfef95601890afd80709
      const hash = sha1(Buffer.alloc(0));
      expect(hash.toString('hex')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    });

    test('SHA-1 of "password"', () => {
      const hash = sha1(Buffer.from('password'));
      expect(hash.toString('hex')).toBe('5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8');
    });

    test('accepts multiple buffers (concatenated)', () => {
      const combined = sha1(Buffer.from('pass'), Buffer.from('word'));
      const single = sha1(Buffer.from('password'));
      expect(combined.toString('hex')).toBe(single.toString('hex'));
    });
  });

  describe('xor', () => {
    test('XOR of identical buffers is all zeros', () => {
      const buf = Buffer.from([0xAB, 0xCD, 0xEF]);
      const result = xor(buf, buf);
      expect(result).toEqual(Buffer.from([0, 0, 0]));
    });

    test('XOR with zero buffer returns original', () => {
      const buf = Buffer.from([0x12, 0x34]);
      const zero = Buffer.from([0, 0]);
      expect(xor(buf, zero)).toEqual(buf);
    });

    test('XOR is reversible', () => {
      const a = Buffer.from([0xDE, 0xAD]);
      const b = Buffer.from([0xBE, 0xEF]);
      const xored = xor(a, b);
      expect(xor(xored, b)).toEqual(a);
    });
  });

  describe('doubleSha1', () => {
    test('returns SHA1(SHA1(password))', () => {
      // Manual: SHA1("password") = 5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8
      // SHA1(that) = should be the double-sha1
      const stage1 = sha1(Buffer.from('password'));
      const expected = sha1(stage1);
      expect(doubleSha1('password').toString('hex')).toBe(expected.toString('hex'));
    });

    test('empty password', () => {
      const result = doubleSha1('');
      expect(result).toBeInstanceOf(Buffer);
      expect(result).toHaveLength(20); // SHA-1 is always 20 bytes
    });
  });

  describe('verifyToken', () => {
    // Simulate the MySQL AUTH_41 handshake:
    //   password = "secret"
    //   SHA1_password = SHA1("secret")
    //   double_sha = SHA1(SHA1_password)
    //   scramble = SHA1(seed1 || seed2 || double_sha)
    //   token = SHA1_password XOR scramble
    // Server verifies: SHA1(token XOR scramble) == double_sha

    const password = 'my_secure_password';
    const seed1 = Buffer.from('12345678'); // 8 bytes
    const seed2 = Buffer.from('123456789012'); // 12 bytes

    function generateToken(pwd: string, s1: Buffer, s2: Buffer): Buffer {
      const sha1Pwd = sha1(Buffer.from(pwd));
      const doubleSha = sha1(sha1Pwd);
      const scramble = sha1(s1.slice(0, 8), s2.slice(0, 12), doubleSha);
      return xor(sha1Pwd, scramble);
    }

    test('valid token returns true', () => {
      const doubleSha = doubleSha1(password);
      const token = generateToken(password, seed1, seed2);
      expect(verifyToken(seed1, seed2, token, doubleSha)).toBe(true);
    });

    test('wrong password returns false', () => {
      const doubleSha = doubleSha1(password);
      const wrongToken = generateToken('wrong_password', seed1, seed2);
      expect(verifyToken(seed1, seed2, wrongToken, doubleSha)).toBe(false);
    });

    test('corrupted token returns false', () => {
      const doubleSha = doubleSha1(password);
      const token = generateToken(password, seed1, seed2);
      token[0] ^= 0xFF; // flip bits
      expect(verifyToken(seed1, seed2, token, doubleSha)).toBe(false);
    });

    test('different seeds produce different results', () => {
      const doubleSha = doubleSha1(password);
      const token = generateToken(password, seed1, seed2);
      const otherSeed1 = Buffer.from('ABCDEFGH');
      expect(verifyToken(otherSeed1, seed2, token, doubleSha)).toBe(false);
    });
  });
});

// =====================================================================
// Capability flag helpers
// =====================================================================

describe('capability flag helpers', () => {
  describe('formatCapabilityFlags', () => {
    test('zero -> 0x00000000', () => {
      expect(formatCapabilityFlags(0)).toBe('0x00000000');
    });

    test('pads to 8 hex digits', () => {
      expect(formatCapabilityFlags(0xFF)).toBe('0x000000ff');
    });

    test('full 32-bit value', () => {
      expect(formatCapabilityFlags(0xDEADBEEF)).toBe('0xdeadbeef');
    });
  });

  describe('describeCapabilityFlags', () => {
    test('zero -> empty array', () => {
      expect(describeCapabilityFlags(0)).toEqual([]);
    });

    test('single flag', () => {
      expect(describeCapabilityFlags(0x00000001)).toEqual(['LONG_PASSWORD']);
    });

    test('multiple flags', () => {
      const flags = 0x00000001 | 0x00000200 | 0x00080000;
      const names = describeCapabilityFlags(flags);
      expect(names).toContain('LONG_PASSWORD');
      expect(names).toContain('PROTOCOL_41');
      expect(names).toContain('PLUGIN_AUTH');
    });

    test('unknown bits are ignored', () => {
      const names = describeCapabilityFlags(0x80000000);
      expect(names).toEqual([]);
    });

    test('CONNECT_ATTRS flag', () => {
      expect(describeCapabilityFlags(0x00100000)).toContain('CONNECT_ATTRS');
    });

    test('PLUGIN_AUTH_LENENC_CLIENT_DATA flag', () => {
      expect(describeCapabilityFlags(0x00200000)).toContain('PLUGIN_AUTH_LENENC_CLIENT_DATA');
    });
  });
});

// =====================================================================
// compactSqlForLog
// =====================================================================

describe('compactSqlForLog', () => {
  test('short SQL returned as-is (normalized whitespace)', () => {
    expect(compactSqlForLog('SELECT  *  FROM  users')).toBe('SELECT * FROM users');
  });

  test('newlines and tabs collapsed', () => {
    expect(compactSqlForLog('SELECT\n  *\n  FROM\n  users')).toBe('SELECT * FROM users');
  });

  test('long SQL truncated with ellipsis', () => {
    const longSql = 'SELECT ' + 'x'.repeat(500) + ' FROM users';
    const result = compactSqlForLog(longSql, 50);
    expect(result).toHaveLength(53); // 50 + "..."
    expect(result.endsWith('...')).toBe(true);
  });

  test('exactly at maxLen not truncated', () => {
    const sql = 'x'.repeat(300);
    expect(compactSqlForLog(sql)).toBe(sql);
    expect(compactSqlForLog(sql).endsWith('...')).toBe(false);
  });

  test('custom maxLen', () => {
    const sql = 'SELECT * FROM a_very_long_table_name';
    const result = compactSqlForLog(sql, 10);
    expect(result).toBe('SELECT * F...');
  });
});
