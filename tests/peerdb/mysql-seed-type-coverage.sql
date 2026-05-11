GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'peerdb'@'%';
FLUSH PRIVILEGES;

CREATE TABLE IF NOT EXISTS type_coverage (
  id INT AUTO_INCREMENT PRIMARY KEY,
  col_tinyint_signed    TINYINT,
  col_smallint          SMALLINT,
  col_mediumint         MEDIUMINT,
  col_int_unsigned      INT UNSIGNED,
  col_bigint_unsigned   BIGINT UNSIGNED,
  col_double            DOUBLE,
  col_decimal_5_0       DECIMAL(5,0),
  col_decimal_20_10     DECIMAL(20,10),
  col_char_10           CHAR(10),
  col_tinytext          TINYTEXT,
  col_mediumtext        MEDIUMTEXT,
  col_longtext          LONGTEXT,
  col_binary_4          BINARY(4),
  col_varbinary_64      VARBINARY(64),
  col_tinyblob          TINYBLOB,
  col_mediumblob        MEDIUMBLOB,
  col_longblob          LONGBLOB,
  col_date              DATE,
  col_time              TIME,
  col_time_6            TIME(6),
  col_timestamp         TIMESTAMP NULL,
  col_timestamp_6       TIMESTAMP(6) NULL,
  col_datetime_6        DATETIME(6),
  col_year              YEAR,
  col_set               SET('a','b','c','d'),
  col_bit_1             BIT(1),
  col_bit_8             BIT(8),
  col_json              JSON,
  col_enum              ENUM('alpha','beta','gamma','delta'),
  col_boolean           BOOLEAN,
  col_utf8_emoji        VARCHAR(100),
  col_date_zero         DATE,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS type_coverage_cdc (
  id INT AUTO_INCREMENT PRIMARY KEY,
  col_tinyint_signed    TINYINT,
  col_smallint          SMALLINT,
  col_mediumint         MEDIUMINT,
  col_int_unsigned      INT UNSIGNED,
  col_bigint_unsigned   BIGINT UNSIGNED,
  col_double            DOUBLE,
  col_decimal_5_0       DECIMAL(5,0),
  col_decimal_20_10     DECIMAL(20,10),
  col_char_10           CHAR(10),
  col_tinytext          TINYTEXT,
  col_mediumtext        MEDIUMTEXT,
  col_longtext          LONGTEXT,
  col_date              DATE,
  col_time              TIME,
  col_timestamp         TIMESTAMP NULL,
  col_datetime_6        DATETIME(6),
  col_year              YEAR,
  col_set               SET('a','b','c','d'),
  col_json              JSON,
  col_enum              ENUM('alpha','beta','gamma','delta'),
  col_boolean           BOOLEAN,
  col_utf8_emoji        VARCHAR(100),
  col_date_zero         DATE,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '');

INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_date, col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  col_json, col_enum,
  col_boolean, col_utf8_emoji, col_date_zero,
  created_at, updated_at
) VALUES (
  1, -128, -32768, -8388608,
  4294967295, 9000000000000000000,
  1.7976931348623157E+308, 99999, 1234567890.1234567890,
  'ABCDEFGHIJ', 'tiny', 'medium text value', 'long text value',
  X'DEADBEEF', X'CAFEBABE', X'FF', X'AABBCCDD', X'0102030405',
  '2025-06-15', '23:59:59', '23:59:59.123456', '2025-06-15 12:30:45', '2025-06-15 12:30:45.654321', '2025-06-15 12:30:45.654321', 2025,
  'a,c,d', b'1', b'11111111',
  '{"name":"test","tags":["a","b"],"nested":{"key":1},"flag":true,"nothing":null}', 'gamma',
  TRUE, 'Hello 🦆 World 𝌆 Test', '0000-00-00',
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);

INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_date, col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  col_json, col_enum,
  col_boolean, col_utf8_emoji, col_date_zero,
  created_at, updated_at
) VALUES (
  2, 0, 0, 0,
  0, 0,
  -3.14159265358979, 0, 0.0000000000,
  '', '', '', '',
  X'00000000', X'00', X'00', X'00', X'00',
  '1970-01-01', '00:00:00', '00:00:00.000000', '1970-01-01 00:00:01', '1970-01-01 00:00:01.000000', '1970-01-01 00:00:01.000000', 1970,
  '', b'0', b'00000000',
  '[]', 'alpha',
  FALSE, '', '1000-01-01',
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);

INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_date, col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  col_json, col_enum,
  col_boolean, col_utf8_emoji, col_date_zero,
  created_at, updated_at
) VALUES (
  3, NULL, NULL, NULL,
  NULL, NULL,
  NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL,
  NULL, NULL,
  NULL, NULL, NULL,
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);
