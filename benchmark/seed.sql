-- =============================================
-- Duckling Benchmark: Seed Data
-- Generates users (100K), products (10K), orders (20M)
-- =============================================

-- -------------------------------------------------
-- Seed users (100,000 rows)
-- Cross-join: 10^5 = 100,000
-- -------------------------------------------------
INSERT INTO users (name, email, region, created_at, updated_at)
SELECT
  CONCAT('User_', n),
  CONCAT('user', n, '@example.com'),
  ELT(1 + (n % 8), 'us-east', 'us-west', 'eu-west', 'eu-east', 'ap-south', 'ap-east', 'sa-east', 'af-south'),
  DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 1825) DAY),
  NOW()
FROM (
  SELECT a.d * 10000 + b.d * 1000 + c.d * 100 + d.d * 10 + e.d + 1 AS n
  FROM
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e
) nums;

SELECT CONCAT('✓ Users seeded: ', FORMAT(COUNT(*), 0)) AS status FROM users;

-- -------------------------------------------------
-- Seed products (10,000 rows)
-- Cross-join: 10^4 = 10,000
-- -------------------------------------------------
INSERT INTO products (name, category, price, created_at, updated_at)
SELECT
  CONCAT('Product_', n),
  ELT(1 + (n % 10), 'electronics', 'clothing', 'food', 'books', 'toys', 'sports', 'home', 'garden', 'auto', 'health'),
  ROUND(5 + RAND() * 995, 2),
  DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 365) DAY),
  NOW()
FROM (
  SELECT a.d * 1000 + b.d * 100 + c.d * 10 + d.d + 1 AS n
  FROM
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
    (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d
) nums;

SELECT CONCAT('✓ Products seeded: ', FORMAT(COUNT(*), 0)) AS status FROM products;

-- -------------------------------------------------
-- Seed orders procedure
-- Each batch inserts 10,000 rows via cross-join (10^4)
-- Default: 2000 batches = 20,000,000 rows
-- -------------------------------------------------
DELIMITER //
CREATE PROCEDURE seed_orders(IN total_batches INT)
BEGIN
  DECLARE i INT DEFAULT 0;

  SET @old_autocommit = @@autocommit;
  SET @old_unique_checks = @@unique_checks;
  SET @old_foreign_key_checks = @@foreign_key_checks;

  SET autocommit = 0;
  SET unique_checks = 0;
  SET foreign_key_checks = 0;

  WHILE i < total_batches DO
    INSERT INTO orders (user_id, product_id, quantity, unit_price, total_amount, status, region, order_date, created_at, updated_at)
    SELECT
      FLOOR(1 + RAND() * 100000),
      FLOOR(1 + RAND() * 10000),
      FLOOR(1 + RAND() * 20) AS qty,
      ROUND(10 + RAND() * 990, 2) AS price,
      ROUND((1 + FLOOR(RAND() * 20)) * (10 + RAND() * 990), 2),
      ELT(1 + FLOOR(RAND() * 5), 'pending', 'processing', 'shipped', 'delivered', 'cancelled'),
      ELT(1 + FLOOR(RAND() * 8), 'us-east', 'us-west', 'eu-west', 'eu-east', 'ap-south', 'ap-east', 'sa-east', 'af-south'),
      DATE_ADD('2020-01-01', INTERVAL FLOOR(RAND() * 1825) DAY),
      DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 1825) DAY),
      NOW()
    FROM
      (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
      CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
      CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
      CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d;

    SET i = i + 1;

    IF MOD(i, 100) = 0 THEN
      COMMIT;
      SELECT CONCAT('  Orders progress: ', FORMAT(i * 10000, 0), ' / ', FORMAT(total_batches * 10000, 0), ' rows (', ROUND(i / total_batches * 100, 1), '%)') AS progress;
    END IF;
  END WHILE;

  COMMIT;

  SET autocommit = @old_autocommit;
  SET unique_checks = @old_unique_checks;
  SET foreign_key_checks = @old_foreign_key_checks;
END //
DELIMITER ;

-- Execute seeding (batch count replaced by run.sh via sed)
CALL seed_orders(SEED_BATCH_COUNT);
DROP PROCEDURE IF EXISTS seed_orders;

SELECT CONCAT('✓ Orders seeded: ', FORMAT(COUNT(*), 0)) AS status FROM orders;

-- -------------------------------------------------
-- Add indexes after bulk insert
-- -------------------------------------------------
SELECT 'Adding indexes...' AS status;

ALTER TABLE users ADD INDEX idx_users_region (region);
ALTER TABLE users ADD INDEX idx_users_created (created_at);

ALTER TABLE products ADD INDEX idx_products_category (category);

ALTER TABLE orders ADD INDEX idx_orders_user_id (user_id);
ALTER TABLE orders ADD INDEX idx_orders_product_id (product_id);
ALTER TABLE orders ADD INDEX idx_orders_status (status);
ALTER TABLE orders ADD INDEX idx_orders_region (region);
ALTER TABLE orders ADD INDEX idx_orders_order_date (order_date);
ALTER TABLE orders ADD INDEX idx_orders_created (created_at);
ALTER TABLE orders ADD INDEX idx_orders_updated (updated_at);

SELECT '✓ Indexes created!' AS status;

-- Final verification
SELECT '--- Final Row Counts ---' AS status;
SELECT 'users' AS table_name, FORMAT(COUNT(*), 0) AS row_count FROM users
UNION ALL SELECT 'products', FORMAT(COUNT(*), 0) FROM products
UNION ALL SELECT 'orders', FORMAT(COUNT(*), 0) FROM orders;
