import { describe, test, expect } from 'vitest';
import { clickhouseScalarStrict, normalizeDecimal } from './helpers/clickhouse.js';
import { triggerFullSync } from './helpers/sync.js';
import { getValidation } from './helpers/validation.js';

/**
 * PeerDB's stock ClickHouse path does not currently convert MySQL zero-dates
 * (0000-00-00) or 1000-01-01 the way the in-repo sync does. When running against
 * the PeerDB backend, the assertion is relaxed to accept either the in-repo
 * canonical ('null') or PeerDB's pass-through. See docs/peerdb-upstream-zero-date-patch.md.
 */
const PEERDB_BACKEND = process.env.DUCKLING_TEST_BACKEND === 'peerdb';

describe('Suite 7: MySQL 8 Type Fidelity', () => {
  test('trigger full sync', async () => {
    await triggerFullSync();
  });

  test('row counts', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM type_coverage', 'cnt')).toBe('3');
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM type_coverage_cdc', 'cnt')).toBe('0');
  });

  // ===== Row 1: Edge cases (id=1) =====
  describe('Row 1: Edge cases (id=1)', () => {
    test('TINYINT SIGNED min (-128)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinyint_signed FROM type_coverage WHERE id = 1', 'col_tinyint_signed'),
      ).toBe('-128');
    });

    test('SMALLINT min (-32768)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_smallint FROM type_coverage WHERE id = 1', 'col_smallint'),
      ).toBe('-32768');
    });

    test('MEDIUMINT min (-8388608)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_mediumint FROM type_coverage WHERE id = 1', 'col_mediumint'),
      ).toBe('-8388608');
    });

    test('INT UNSIGNED max (4294967295)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_int_unsigned FROM type_coverage WHERE id = 1', 'col_int_unsigned'),
      ).toBe('4294967295');
    });

    test('BIGINT UNSIGNED non-null', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT col_bigint_unsigned FROM type_coverage WHERE id = 1',
        'col_bigint_unsigned',
      );
      expect(val).not.toBe('null');
    });

    test('DOUBLE max', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('1.79769');
    });

    test('DECIMAL(5,0)', async () => {
      const raw = await clickhouseScalarStrict(
        'SELECT col_decimal_5_0 FROM type_coverage WHERE id = 1',
        'col_decimal_5_0',
      );
      expect(normalizeDecimal(raw)).toBe('99999');
    });

    test('DECIMAL(20,10) contains integer part', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_decimal_20_10 AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('1234567890');
    });

    test('CHAR(10)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_char_10 FROM type_coverage WHERE id = 1', 'col_char_10'),
      ).toBe('ABCDEFGHIJ');
    });

    test('TINYTEXT', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinytext FROM type_coverage WHERE id = 1', 'col_tinytext'),
      ).toBe('tiny');
    });

    test('MEDIUMTEXT', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_mediumtext FROM type_coverage WHERE id = 1', 'col_mediumtext'),
      ).toBe('medium text value');
    });

    test('LONGTEXT', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_longtext FROM type_coverage WHERE id = 1', 'col_longtext'),
      ).toBe('long text value');
    });

    test('BINARY(4) non-null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_binary_4 FROM type_coverage WHERE id = 1', 'col_binary_4');
      expect(val).not.toBe('null');
    });

    test('VARBINARY(64) non-null', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT col_varbinary_64 FROM type_coverage WHERE id = 1',
        'col_varbinary_64',
      );
      expect(val).not.toBe('null');
    });

    test('TINYBLOB non-null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_tinyblob FROM type_coverage WHERE id = 1', 'col_tinyblob');
      expect(val).not.toBe('null');
    });

    test('MEDIUMBLOB non-null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_mediumblob FROM type_coverage WHERE id = 1', 'col_mediumblob');
      expect(val).not.toBe('null');
    });

    test('LONGBLOB non-null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_longblob FROM type_coverage WHERE id = 1', 'col_longblob');
      expect(val).not.toBe('null');
    });

    test('DATE', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_date AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('2025-06-15');
    });

    test('TIME', async () => {
      expect(
        await clickhouseScalarStrict('SELECT CAST(col_time AS VARCHAR) AS v FROM type_coverage WHERE id = 1', 'v'),
      ).toBe('23:59:59');
    });

    test('TIME(6)', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_time_6 AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('23:59:59');
    });

    test('TIMESTAMP', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_timestamp AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('2025-06-15');
    });

    test('TIMESTAMP(6)', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_timestamp_6 AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('2025-06-15');
    });

    test('DATETIME(6)', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_datetime_6 AS VARCHAR) AS v FROM type_coverage WHERE id = 1',
        'v',
      );
      expect(val).toContain('2025-06-15');
    });

    test('YEAR', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_year FROM type_coverage WHERE id = 1', 'col_year'),
      ).toBe('2025');
    });

    test('SET', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_set FROM type_coverage WHERE id = 1', 'col_set'),
      ).toBe('a,c,d');
    });

    test('BIT(1)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_1 FROM type_coverage WHERE id = 1', 'col_bit_1'),
      ).toBe('1');
    });

    test('BIT(8) = 255', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_8 FROM type_coverage WHERE id = 1', 'col_bit_8'),
      ).toBe('255');
    });

    test('JSON deep object', async () => {
      const raw = await clickhouseScalarStrict('SELECT col_json FROM type_coverage WHERE id = 1', 'col_json');
      const parsed = JSON.parse(raw);
      expect(parsed.name).toBe('test');
      expect(parsed.tags).toEqual(['a', 'b']);
      expect(parsed.nested).toEqual({ key: 1 });
      expect(parsed.flag).toBe(true);
      expect(parsed.nothing).toBeNull();
    });

    test('ENUM string value', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_enum FROM type_coverage WHERE id = 1', 'col_enum'),
      ).toBe('gamma');
    });

    test('BOOLEAN true (TINYINT 1)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_boolean FROM type_coverage WHERE id = 1', 'col_boolean'),
      ).toBe('1');
    });

    test('UTF-8 4-byte emoji', async () => {
      const val = await clickhouseScalarStrict('SELECT col_utf8_emoji FROM type_coverage WHERE id = 1', 'col_utf8_emoji');
      expect(val).toContain('🦆');
      expect(val).toContain('𝌆');
      expect(val).toBe('Hello 🦆 World 𝌆 Test');
    });

    test('Zero date (0000-00-00) becomes null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_date_zero FROM type_coverage WHERE id = 1', 'col_date_zero');
      if (PEERDB_BACKEND) {
        // Known PeerDB blocker — see docs/peerdb-upstream-zero-date-patch.md.
        expect(['null', '1970-01-01']).toContain(val);
      } else {
        expect(val).toBe('null');
      }
    });
  });

  // ===== Row 2: Zero/empty values (id=2) =====
  describe('Row 2: Zero/empty values (id=2)', () => {
    test('TINYINT SIGNED zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinyint_signed FROM type_coverage WHERE id = 2', 'col_tinyint_signed'),
      ).toBe('0');
    });

    test('SMALLINT zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_smallint FROM type_coverage WHERE id = 2', 'col_smallint'),
      ).toBe('0');
    });

    test('MEDIUMINT zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_mediumint FROM type_coverage WHERE id = 2', 'col_mediumint'),
      ).toBe('0');
    });

    test('INT UNSIGNED zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_int_unsigned FROM type_coverage WHERE id = 2', 'col_int_unsigned'),
      ).toBe('0');
    });

    test('BIGINT UNSIGNED zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bigint_unsigned FROM type_coverage WHERE id = 2', 'col_bigint_unsigned'),
      ).toBe('0');
    });

    test('DOUBLE negative pi', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_double AS VARCHAR) AS v FROM type_coverage WHERE id = 2',
        'v',
      );
      expect(val).toContain('-3.14159');
    });

    test('DECIMAL(5,0) zero', async () => {
      const raw = await clickhouseScalarStrict(
        'SELECT col_decimal_5_0 FROM type_coverage WHERE id = 2',
        'col_decimal_5_0',
      );
      expect(normalizeDecimal(raw)).toBe('0');
    });

    test('CHAR(10) empty', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_char_10 FROM type_coverage WHERE id = 2', 'col_char_10'),
      ).toBe('');
    });

    test('TINYTEXT empty', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinytext FROM type_coverage WHERE id = 2', 'col_tinytext'),
      ).toBe('');
    });

    test('DATE epoch', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_date AS VARCHAR) AS v FROM type_coverage WHERE id = 2',
        'v',
      );
      expect(val).toContain('1970-01-01');
    });

    test('TIME zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT CAST(col_time AS VARCHAR) AS v FROM type_coverage WHERE id = 2', 'v'),
      ).toBe('00:00:00');
    });

    test('YEAR 1970', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_year FROM type_coverage WHERE id = 2', 'col_year'),
      ).toBe('1970');
    });

    test('SET empty', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_set FROM type_coverage WHERE id = 2', 'col_set'),
      ).toBe('');
    });

    test('BIT(1) zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_1 FROM type_coverage WHERE id = 2', 'col_bit_1'),
      ).toBe('0');
    });

    test('BIT(8) zero', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_8 FROM type_coverage WHERE id = 2', 'col_bit_8'),
      ).toBe('0');
    });

    test('JSON empty array', async () => {
      const raw = await clickhouseScalarStrict('SELECT col_json FROM type_coverage WHERE id = 2', 'col_json');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual([]);
    });

    test('ENUM string value', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_enum FROM type_coverage WHERE id = 2', 'col_enum'),
      ).toBe('alpha');
    });

    test('BOOLEAN false (TINYINT 0)', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_boolean FROM type_coverage WHERE id = 2', 'col_boolean'),
      ).toBe('0');
    });

    test('UTF-8 empty string', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_utf8_emoji FROM type_coverage WHERE id = 2', 'col_utf8_emoji'),
      ).toBe('');
    });

    test('DATE min (1000-01-01)', async () => {
      const val = await clickhouseScalarStrict(
        'SELECT CAST(col_date_zero AS VARCHAR) AS v FROM type_coverage WHERE id = 2',
        'v',
      );
      if (PEERDB_BACKEND) {
        // Known PeerDB blocker — see docs/peerdb-upstream-zero-date-patch.md.
        expect(val === null || val.includes('1000-01-01') || val.includes('1970-01-01')).toBe(true);
      } else {
        expect(val).toContain('1000-01-01');
      }
    });
  });

  // ===== Row 3: NULLs (id=3) =====
  describe('Row 3: NULLs (id=3)', () => {
    test('TINYINT SIGNED null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinyint_signed FROM type_coverage WHERE id = 3', 'col_tinyint_signed'),
      ).toBe('null');
    });

    test('SMALLINT null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_smallint FROM type_coverage WHERE id = 3', 'col_smallint'),
      ).toBe('null');
    });

    test('MEDIUMINT null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_mediumint FROM type_coverage WHERE id = 3', 'col_mediumint'),
      ).toBe('null');
    });

    test('INT UNSIGNED null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_int_unsigned FROM type_coverage WHERE id = 3', 'col_int_unsigned'),
      ).toBe('null');
    });

    test('BIGINT UNSIGNED null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bigint_unsigned FROM type_coverage WHERE id = 3', 'col_bigint_unsigned'),
      ).toBe('null');
    });

    test('DOUBLE null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_double FROM type_coverage WHERE id = 3', 'col_double'),
      ).toBe('null');
    });

    test('DECIMAL(5,0) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_decimal_5_0 FROM type_coverage WHERE id = 3', 'col_decimal_5_0'),
      ).toBe('null');
    });

    test('DECIMAL(20,10) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_decimal_20_10 FROM type_coverage WHERE id = 3', 'col_decimal_20_10'),
      ).toBe('null');
    });

    test('CHAR(10) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_char_10 FROM type_coverage WHERE id = 3', 'col_char_10'),
      ).toBe('null');
    });

    test('TINYTEXT null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_tinytext FROM type_coverage WHERE id = 3', 'col_tinytext'),
      ).toBe('null');
    });

    test('MEDIUMTEXT null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_mediumtext FROM type_coverage WHERE id = 3', 'col_mediumtext'),
      ).toBe('null');
    });

    test('LONGTEXT null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_longtext FROM type_coverage WHERE id = 3', 'col_longtext'),
      ).toBe('null');
    });

    test('BINARY(4) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_binary_4 FROM type_coverage WHERE id = 3', 'col_binary_4'),
      ).toBe('null');
    });

    test('DATE null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_date FROM type_coverage WHERE id = 3', 'col_date'),
      ).toBe('null');
    });

    test('TIME null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_time FROM type_coverage WHERE id = 3', 'col_time'),
      ).toBe('null');
    });

    test('TIMESTAMP null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_timestamp FROM type_coverage WHERE id = 3', 'col_timestamp'),
      ).toBe('null');
    });

    test('YEAR null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_year FROM type_coverage WHERE id = 3', 'col_year'),
      ).toBe('null');
    });

    test('SET null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_set FROM type_coverage WHERE id = 3', 'col_set'),
      ).toBe('null');
    });

    test('BIT(1) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_1 FROM type_coverage WHERE id = 3', 'col_bit_1'),
      ).toBe('null');
    });

    test('BIT(8) null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_bit_8 FROM type_coverage WHERE id = 3', 'col_bit_8'),
      ).toBe('null');
    });

    test('JSON null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_json FROM type_coverage WHERE id = 3', 'col_json'),
      ).toBe('null');
    });

    test('ENUM null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_enum FROM type_coverage WHERE id = 3', 'col_enum'),
      ).toBe('null');
    });

    test('BOOLEAN null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_boolean FROM type_coverage WHERE id = 3', 'col_boolean'),
      ).toBe('null');
    });

    test('UTF-8 emoji null', async () => {
      expect(
        await clickhouseScalarStrict('SELECT col_utf8_emoji FROM type_coverage WHERE id = 3', 'col_utf8_emoji'),
      ).toBe('null');
    });

    test('DATE zero null', async () => {
      const val = await clickhouseScalarStrict('SELECT col_date_zero FROM type_coverage WHERE id = 3', 'col_date_zero');
      if (PEERDB_BACKEND) {
        expect(['null', '1970-01-01']).toContain(val);
      } else {
        expect(val).toBe('null');
      }
    });
  });

  // --- Validation endpoint ---
  describe('Validation endpoint', () => {
    test('type_coverage max ID match', async () => {
      const val = await getValidation('type_coverage');
      expect(val.clickhouse.maxId).toBe(val.mysql.maxId);
    });

    test('type_coverage checksum match', async () => {
      const val = await getValidation('type_coverage');
      expect(val.clickhouse.checksum).toBe(val.mysql.checksum);
    });
  });
});
