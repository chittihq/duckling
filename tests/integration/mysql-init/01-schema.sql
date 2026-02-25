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
