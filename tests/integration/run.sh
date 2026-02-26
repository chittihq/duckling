#!/usr/bin/env bash
# ============================================================
# Duckling Integration Tests: Orchestration
#
# Handles Docker lifecycle, MySQL seeding, and runs vitest.
# All test assertions live in src/*.test.ts
#
# Usage:
#   cd tests/integration
#   chmod +x run.sh
#   ./run.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --------------- Configuration ---------------
API_KEY="integration-test-key"
API_URL="http://localhost:3002"
DB_ID="integration"
TIMEOUT_STARTUP="${DUCKLING_TEST_TIMEOUT_STARTUP:-180}"

# --------------- Helpers ---------------
log() { echo -e "\033[0;34m[$(date +%H:%M:%S)]\033[0m $*"; }
ok()  { echo -e "  \033[0;32mPASS\033[0m $*"; }
fail(){ echo -e "  \033[0;31mFAIL\033[0m $*"; }

cleanup() {
  echo ""
  log "--- Server error.log (last 100 lines) ---"
  docker compose exec -T duckling tail -100 /app/data/logs/error.log 2>/dev/null || echo "(no error.log)"
  log "--- Server sync.log (last 200 lines) ---"
  docker compose exec -T duckling tail -200 /app/data/logs/sync.log 2>/dev/null || echo "(no sync.log)"
  log "--- End server logs ---"
  log "Cleaning up..."
  docker compose down -v 2>/dev/null || true
  rm -rf data/ 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT

check_deps() {
  local missing=0
  for cmd in docker pnpm; do
    if ! command -v "$cmd" &>/dev/null; then
      fail "'$cmd' is required but not installed"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then exit 1; fi
  if ! docker compose version &>/dev/null; then
    fail "'docker compose' plugin is required"
    exit 1
  fi
}

# ===============================================================
# MAIN
# ===============================================================

echo -e "\033[1m\033[0;36m╔══════════════════════════════════════════════════════════════╗\033[0m"
echo -e "\033[1m\033[0;36m║           Duckling Integration Test Suite                    ║\033[0m"
echo -e "\033[1m\033[0;36m║       MySQL → DuckDB Replication (vitest)                    ║\033[0m"
echo -e "\033[1m\033[0;36m╚══════════════════════════════════════════════════════════════╝\033[0m"
echo ""

check_deps

# ------- Step 1: Prepare environment -------
log "[1/5] Preparing environment..."
rm -rf data/
mkdir -p data
cat > data/databases.json << EOJSON
[
  {
    "id": "${DB_ID}",
    "name": "Integration",
    "mysqlConnectionString": "mysql://integration:integrationpass@mysql:3306/integration_db",
    "duckdbPath": "data/integration.db",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
EOJSON
ok "Environment ready"

# ------- Step 2: Start MySQL & seed data -------
log "[2/5] Starting MySQL..."
docker compose up -d mysql
echo -n "  Waiting for MySQL health check"
until docker compose exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -prootpass --silent 2>/dev/null; do
  echo -n "."
  sleep 2
done
echo ""
ok "MySQL is ready"

log "Seeding test data..."
docker compose exec -T mysql mysql -h 127.0.0.1 -uroot -prootpass integration_db << 'EOSQL'

-- Grant all privileges to the integration user
GRANT ALL PRIVILEGES ON integration_db.* TO 'integration'@'%';
FLUSH PRIVILEGES;

-- Seed users_with_timestamps (5 rows, full type coverage)
INSERT INTO users_with_timestamps (id, name, age, email, bio, balance, is_active, metadata, avatar, birth_date, role, score, created_at, updated_at) VALUES
  (1, 'Alice',   30, 'alice@test.com',   'Engineer at ACME',  1500.50, TRUE,  '{"level":5,"tags":["admin","dev"]}', X'89504E47', '1994-06-15', 'admin',  92.5,  '2025-01-01 10:00:00', '2025-01-01 10:00:00'),
  (2, 'Bob',     25, 'bob@test.com',     'Designer',          2500.00, TRUE,  '{"level":3,"tags":["design"]}',      NULL,        '1999-03-22', 'editor', 88.0,  '2025-01-02 10:00:00', '2025-01-02 10:00:00'),
  (3, 'Charlie', 35, 'charlie@test.com', 'Manager',           3200.75, FALSE, '{"level":7,"tags":["mgmt"]}',        X'FFD8FFE0', '1989-11-08', 'viewer', 76.3,  '2025-01-03 10:00:00', '2025-01-03 10:00:00'),
  (4, 'Diana',   28, 'diana@test.com',   NULL,                  50.00, TRUE,  NULL,                                 NULL,        '1996-09-30', 'viewer', NULL,  '2025-01-04 10:00:00', '2025-01-04 10:00:00'),
  (5, 'Eve',     42, 'eve@test.com',     'CEO',              99999.99, TRUE,  '{"level":10,"tags":["exec"]}',       X'504B0304', '1982-12-01', 'admin',  99.9,  '2025-01-05 10:00:00', '2025-01-05 10:00:00');

-- Seed events_append_only (3 rows, BIGINT pk, append-only)
INSERT INTO events_append_only (id, event_type, payload, amount, created_at) VALUES
  (1, 'page_view',  '{"page":"/home","browser":"chrome"}',     0.0000, '2025-01-01 08:00:00'),
  (2, 'purchase',   '{"item":"widget","qty":3}',             149.9900, '2025-01-02 09:00:00'),
  (3, 'signup',     '{"source":"organic","campaign":"none"}',   0.0000, '2025-01-03 10:00:00');

-- Seed products_simple (4 rows, straightforward validation)
INSERT INTO products_simple (id, name, price, quantity, updated_at) VALUES
  (1, 'Widget A',   29.99,  100, '2025-01-01 12:00:00'),
  (2, 'Widget B',   49.99,   50, '2025-01-02 12:00:00'),
  (3, 'Gadget C',  199.99,   10, '2025-01-03 12:00:00'),
  (4, 'Gadget D',    9.99, 1000, '2025-01-04 12:00:00');

-- Seed type_coverage (3 rows: edge cases, zeros/empty, NULLs)
-- Row 1: Edge cases — min/max/boundary values
INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  created_at, updated_at
) VALUES (
  1, -128, -32768, -8388608,
  4294967295, 9000000000000000000,
  1.7976931348623157E+308, 99999, 1234567890.1234567890,
  'ABCDEFGHIJ', 'tiny', 'medium text value', 'long text value',
  X'DEADBEEF', X'CAFEBABE', X'FF', X'AABBCCDD', X'0102030405',
  '23:59:59', '23:59:59.123456', '2025-06-15 12:30:45', '2025-06-15 12:30:45.654321', '2025-06-15 12:30:45.654321', 2025,
  'a,c,d', b'1', b'11111111',
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);

-- Row 2: Zero/empty/min values
INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  created_at, updated_at
) VALUES (
  2, 0, 0, 0,
  0, 0,
  -3.14159265358979, 0, 0.0000000000,
  '', '', '', '',
  X'00000000', X'00', X'00', X'00', X'00',
  '00:00:00', '00:00:00.000000', '1970-01-01 00:00:01', '1970-01-01 00:00:01.000000', '1970-01-01 00:00:01.000000', 1970,
  '', b'0', b'00000000',
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);

-- Row 3: All NULLs (except id and non-nullable created_at/updated_at)
INSERT INTO type_coverage (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_binary_4, col_varbinary_64, col_tinyblob, col_mediumblob, col_longblob,
  col_time, col_time_6, col_timestamp, col_timestamp_6, col_datetime_6, col_year,
  col_set, col_bit_1, col_bit_8,
  created_at, updated_at
) VALUES (
  3, NULL, NULL, NULL,
  NULL, NULL,
  NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL,
  '2025-01-01 00:00:00', '2025-01-01 00:00:00'
);

-- type_coverage_cdc: no initial rows (seeded via CDC in Suite 6)

EOSQL
ok "Seed data inserted"

# ------- Step 3: Start Duckling -------
log "[3/5] Starting Duckling server..."
docker compose up -d --build duckling
echo -n "  Waiting for Duckling health check"
duckling_wait=0
until curl -sf "${API_URL}/health?db=${DB_ID}" -H "Authorization: ${API_KEY}" > /dev/null 2>&1; do
  echo -n "."
  sleep 3
  duckling_wait=$((duckling_wait + 3))
  if [ "$duckling_wait" -ge "$TIMEOUT_STARTUP" ]; then
    fail "Duckling failed to start within ${TIMEOUT_STARTUP}s"
    docker compose logs duckling | tail -50
    exit 1
  fi
done
echo ""
ok "Duckling is ready"

# ------- Step 4: Install test dependencies -------
log "[4/5] Installing test dependencies..."
(cd "$SCRIPT_DIR" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
ok "Dependencies installed"

# ------- Step 5: Run vitest -------
log "[5/5] Running test suites via vitest..."
echo ""
pnpm test
