-- =============================================
-- Duckling Integration Tests: MySQL Schema
-- Three tables covering different sync scenarios
-- =============================================

-- Full type coverage table with both created_at and updated_at
-- Tests watermark priority (updated_at wins over created_at)
CREATE TABLE IF NOT EXISTS users_with_timestamps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  age TINYINT UNSIGNED,
  email VARCHAR(255),
  bio TEXT,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSON,
  avatar BLOB,
  birth_date DATE,
  role ENUM('admin', 'editor', 'viewer') NOT NULL DEFAULT 'viewer',
  score FLOAT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

-- Append-only table with only created_at (no updated_at)
-- Tests fallback timestamp detection for incremental sync
CREATE TABLE IF NOT EXISTS events_append_only (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  payload JSON,
  amount DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB;

-- Grant replication privileges for CDC (binlog access via zongji)
-- Runs as root during docker-entrypoint-initdb.d execution
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'integration'@'%';
FLUSH PRIVILEGES;

-- Minimal table for straightforward validation
-- Has updated_at but no created_at
CREATE TABLE IF NOT EXISTS products_simple (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

-- =============================================
-- Comprehensive type coverage for Suite 7
-- Tests all MySQL 8 data types through full-sync Appender path
-- =============================================
CREATE TABLE IF NOT EXISTS type_coverage (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- Signed integer variants
  col_tinyint_signed    TINYINT,
  col_smallint          SMALLINT,
  col_mediumint         MEDIUMINT,
  col_int_unsigned      INT UNSIGNED,
  col_bigint_unsigned   BIGINT UNSIGNED,

  -- Floating point & decimal variants
  col_double            DOUBLE,
  col_decimal_5_0       DECIMAL(5,0),
  col_decimal_20_10     DECIMAL(20,10),

  -- Fixed-length string
  col_char_10           CHAR(10),

  -- Text variants
  col_tinytext          TINYTEXT,
  col_mediumtext        MEDIUMTEXT,
  col_longtext          LONGTEXT,

  -- Binary variants
  col_binary_4          BINARY(4),
  col_varbinary_64      VARBINARY(64),
  col_tinyblob          TINYBLOB,
  col_mediumblob        MEDIUMBLOB,
  col_longblob          LONGBLOB,

  -- Temporal
  col_time              TIME,
  col_time_6            TIME(6),
  col_timestamp         TIMESTAMP NULL,
  col_timestamp_6       TIMESTAMP(6) NULL,
  col_datetime_6        DATETIME(6),
  col_year              YEAR,

  -- SET, BIT
  col_set               SET('a','b','c','d'),
  col_bit_1             BIT(1),
  col_bit_8             BIT(8),

  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

-- CDC-safe subset (no BLOB/BINARY columns which break INSERT OR REPLACE)
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
  col_time              TIME,
  col_timestamp         TIMESTAMP NULL,
  col_datetime_6        DATETIME(6),
  col_year              YEAR,
  col_set               SET('a','b','c','d'),

  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;
