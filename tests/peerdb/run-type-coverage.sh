#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${ROOT_DIR}/docker-compose.peerdb.yml"
SEED_FILE="${ROOT_DIR}/tests/peerdb/mysql-seed-type-coverage.sql"
API_KEY="${PEERDB_SMOKE_API_KEY:-peerdb-key}"
ADMIN_PASSWORD="${PEERDB_SMOKE_ADMIN_PASSWORD:-admin}"
SESSION_SECRET="${PEERDB_SMOKE_SESSION_SECRET:-peerdb-session}"
MYSQL_CONTAINER="duckling-peerdb-mysql"
MYSQL_DB="peerdbtest"
MYSQL_ROOT_PASSWORD="cipass"
MYSQL_USER="peerdb"
MYSQL_PASSWORD="peerdb"
MYSQL_CONN="mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@${MYSQL_CONTAINER}:3306/${MYSQL_DB}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
FAILURES=()

record_failure() {
  local message="$1"
  echo "FAIL: ${message}" >&2
  FAILURES+=("$message")
}

cleanup() {
  docker rm -f "${MYSQL_CONTAINER}" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  docker network rm duckling-peerdb-network >/dev/null 2>&1 || true
}

trap cleanup EXIT

ch_scalar() {
  local sql="$1"
  docker exec duckling-peerdb-clickhouse clickhouse-client --query "$sql FORMAT TSVRaw"
}

wait_for_exact() {
  local sql="$1"
  local expected="$2"
  local attempts="${3:-45}"
  for _ in $(seq 1 "$attempts"); do
    local got
    got="$(ch_scalar "$sql")"
    if [[ "$got" == "$expected" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  [[ "$actual" == "$expected" ]] || record_failure "${message}: expected '${expected}', got '${actual}'"
}

normalize_decimal() {
  python3 - "$1" <<'PY'
from decimal import Decimal
import sys
value = sys.argv[1]
if value == "null":
    print(value)
else:
    print(Decimal(value).normalize())
PY
}

assert_decimal_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local actual_norm expected_norm
  actual_norm="$(normalize_decimal "$actual")"
  expected_norm="$(normalize_decimal "$expected")"
  [[ "$actual_norm" == "$expected_norm" ]] || record_failure "${message}: expected '${expected}' (${expected_norm}), got '${actual}' (${actual_norm})"
}

assert_non_null() {
  local actual="$1"
  local message="$2"
  [[ "$actual" != "null" && -n "$actual" ]] || record_failure "${message}: expected non-null value"
}

assert_contains() {
  local actual="$1"
  local expected_fragment="$2"
  local message="$3"
  [[ "$actual" == *"$expected_fragment"* ]] || record_failure "${message}: expected '${actual}' to contain '${expected_fragment}'"
}

log "Resetting PeerDB stack"
cleanup

log "Preparing Docker network"
docker network create \
  --label com.docker.compose.network=peerdb-network \
  --label com.docker.compose.project=duckling \
  duckling-peerdb-network >/dev/null 2>&1 || true

log "Starting PeerDB stack"
MYSQL_CONNECTION_STRING="${MYSQL_CONN}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
SESSION_SECRET="${SESSION_SECRET}" \
DUCKLING_API_KEY="${API_KEY}" \
docker compose -f "$COMPOSE_FILE" up -d --build \
  clickhouse rustfs catalog temporal temporal-ui temporal-admin-tools \
  flow-api flow-snapshot-worker flow-worker peerdb peerdb-ui clickhouse-server

log "Creating RustFS staging bucket"
docker run --rm --network duckling-peerdb-network --entrypoint /bin/sh \
  minio/mc:RELEASE.2025-04-08T15-39-49Z \
  -lc "mc alias set rustfs http://duckling-rustfs:9000 peerdb peerdbsecret >/dev/null && mc mb --ignore-existing rustfs/peerdb-stage >/dev/null"

log "Resetting PeerDB catalog and ClickHouse target state"
docker exec duckling-temporal-admin-tools sh -lc "temporal workflow terminate --namespace default --workflow-id duckling_default_type_coverage-peerflow --reason reset" >/dev/null 2>&1 || true
docker exec duckling-temporal-admin-tools sh -lc "temporal workflow terminate --namespace default --workflow-id duckling_default_type_coverage_cdc-peerflow --reason reset" >/dev/null 2>&1 || true
docker exec duckling-peerdb-catalog sh -lc "PGPASSWORD=peerdb psql -h duckling-peerdb-server -p 9900 -U peerdb -d peerdb -c \"DROP MIRROR IF EXISTS duckling_default_type_coverage; DROP MIRROR IF EXISTS duckling_default_type_coverage_cdc;\"" >/dev/null 2>&1 || true
docker exec duckling-peerdb-catalog psql -U postgres -d postgres -c "
DELETE FROM flows
WHERE name IN ('duckling_default_type_coverage','duckling_default_type_coverage_cdc')
   OR source_peer IN (SELECT id FROM peers WHERE name IN ('mysql_default','clickhouse_default'))
   OR destination_peer IN (SELECT id FROM peers WHERE name IN ('mysql_default','clickhouse_default'));
DELETE FROM peers WHERE name IN ('mysql_default','clickhouse_default');
" >/dev/null
docker exec duckling-peerdb-clickhouse clickhouse-client --query "DROP TABLE IF EXISTS default.type_coverage; DROP TABLE IF EXISTS default.type_coverage_cdc; DROP TABLE IF EXISTS default._peerdb_raw_duckling_default_type_coverage; DROP TABLE IF EXISTS default._peerdb_raw_duckling_default_type_coverage_cdc;" >/dev/null 2>&1 || true

log "Starting MySQL source"
docker run -d \
  --name "${MYSQL_CONTAINER}" \
  --network duckling-peerdb-network \
  -e MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD}" \
  -e MYSQL_DATABASE="${MYSQL_DB}" \
  -e MYSQL_USER="${MYSQL_USER}" \
  -e MYSQL_PASSWORD="${MYSQL_PASSWORD}" \
  mysql:8.0 \
  --server-id=1 \
  --log-bin=mysql-bin \
  --binlog-format=ROW \
  --binlog-row-image=FULL \
  --binlog-row-metadata=FULL \
  --gtid-mode=ON \
  --enforce-gtid-consistency=ON >/dev/null

log "Waiting for MySQL source"
mysql_ready=0
for _ in $(seq 1 60); do
  if docker exec "${MYSQL_CONTAINER}" mysql -h 127.0.0.1 -uroot "-p${MYSQL_ROOT_PASSWORD}" -e "SELECT 1" >/dev/null 2>&1; then
    mysql_ready=1
    break
  fi
  sleep 2
done
[[ "$mysql_ready" == "1" ]] || fail "MySQL source did not become ready"

log "Applying type coverage schema + seed"
docker exec -i "${MYSQL_CONTAINER}" mysql -h 127.0.0.1 -uroot "-p${MYSQL_ROOT_PASSWORD}" "${MYSQL_DB}" < "$SEED_FILE"

log "Waiting for Duckling runtime API"
runtime_ready=0
for _ in $(seq 1 60); do
  if docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/status?db=default', {
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
" >/dev/null 2>&1; then
    runtime_ready=1
    break
  fi
  sleep 2
done
[[ "$runtime_ready" == "1" ]] || fail "Duckling runtime API did not become ready"

log "Triggering PeerDB-backed full sync"
docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/full?db=default', {
  method: 'POST',
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then(async (r) => {
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  console.log(text);
}).catch((err) => { console.error(err); process.exit(1); });
"

log "Waiting for mirrors to become visible"
for _ in $(seq 1 45); do
  status_json="$(docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/status?db=default', {
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then(async (r) => console.log(await r.text())).catch((err) => { console.error(err); process.exit(1); });
")"
  if echo "$status_json" | rg '"mirrored":2' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
echo "$status_json" | rg '"mirrored":2' >/dev/null 2>&1 || fail "Type coverage mirrors were not reported as active"

log "Waiting for initial snapshot"
wait_for_exact "SELECT COUNT(*) FROM default.type_coverage FINAL" "3" 60 || fail "type_coverage row count mismatch"
wait_for_exact "SELECT COUNT(*) FROM default.type_coverage_cdc FINAL" "0" 30 || fail "type_coverage_cdc initial row count mismatch"

log "Checking numeric matrix"
assert_eq "$(ch_scalar "SELECT col_tinyint_signed FROM default.type_coverage WHERE id = 1")" "-128" "TINYINT signed edge"
assert_eq "$(ch_scalar "SELECT col_smallint FROM default.type_coverage WHERE id = 1")" "-32768" "SMALLINT edge"
assert_eq "$(ch_scalar "SELECT col_mediumint FROM default.type_coverage WHERE id = 1")" "-8388608" "MEDIUMINT edge"
assert_eq "$(ch_scalar "SELECT col_int_unsigned FROM default.type_coverage WHERE id = 1")" "4294967295" "INT UNSIGNED edge"
assert_non_null "$(ch_scalar "SELECT col_bigint_unsigned FROM default.type_coverage WHERE id = 1")" "BIGINT UNSIGNED edge"
assert_decimal_eq "$(ch_scalar "SELECT col_decimal_5_0 FROM default.type_coverage WHERE id = 1")" "99999" "DECIMAL(5,0)"
assert_decimal_eq "$(ch_scalar "SELECT col_decimal_20_10 FROM default.type_coverage WHERE id = 1")" "1234567890.1234567890" "DECIMAL(20,10)"

log "Checking binary/blob handling"
assert_non_null "$(ch_scalar "SELECT hex(col_binary_4) FROM default.type_coverage WHERE id = 1")" "BINARY(4)"
assert_non_null "$(ch_scalar "SELECT hex(col_varbinary_64) FROM default.type_coverage WHERE id = 1")" "VARBINARY(64)"
assert_non_null "$(ch_scalar "SELECT hex(col_tinyblob) FROM default.type_coverage WHERE id = 1")" "TINYBLOB"
assert_non_null "$(ch_scalar "SELECT hex(col_mediumblob) FROM default.type_coverage WHERE id = 1")" "MEDIUMBLOB"
assert_non_null "$(ch_scalar "SELECT hex(col_longblob) FROM default.type_coverage WHERE id = 1")" "LONGBLOB"

log "Checking date/time edge cases"
assert_eq "$(ch_scalar "SELECT CAST(col_date AS String) FROM default.type_coverage WHERE id = 1")" "2025-06-15" "DATE value"
assert_contains "$(ch_scalar "SELECT CAST(col_time AS String) FROM default.type_coverage WHERE id = 1")" "23:59:59" "TIME value"
assert_contains "$(ch_scalar "SELECT CAST(col_time_6 AS String) FROM default.type_coverage WHERE id = 1")" "23:59:59.123456" "TIME(6) value"
assert_contains "$(ch_scalar "SELECT CAST(col_timestamp AS String) FROM default.type_coverage WHERE id = 1")" "2025-06-15 12:30:45" "TIMESTAMP value"
assert_contains "$(ch_scalar "SELECT CAST(col_timestamp_6 AS String) FROM default.type_coverage WHERE id = 1")" "2025-06-15 12:30:45.654321" "TIMESTAMP(6) value"
assert_contains "$(ch_scalar "SELECT CAST(col_datetime_6 AS String) FROM default.type_coverage WHERE id = 1")" "2025-06-15 12:30:45.654321" "DATETIME(6) value"

log "Checking enum/set/bit/year"
assert_eq "$(ch_scalar "SELECT col_year FROM default.type_coverage WHERE id = 1")" "2025" "YEAR value"
assert_eq "$(ch_scalar "SELECT col_set FROM default.type_coverage WHERE id = 1")" "a,c,d" "SET value"
assert_eq "$(ch_scalar "SELECT col_bit_1 FROM default.type_coverage WHERE id = 1")" "1" "BIT(1) value"
assert_eq "$(ch_scalar "SELECT col_bit_8 FROM default.type_coverage WHERE id = 1")" "255" "BIT(8) value"
assert_eq "$(ch_scalar "SELECT col_enum FROM default.type_coverage WHERE id = 1")" "gamma" "ENUM value"

log "Checking nullability edge cases"
assert_eq "$(ch_scalar "SELECT CAST(col_tinyint_signed AS String) FROM default.type_coverage WHERE id = 3")" "null" "NULL tinyint"
assert_eq "$(ch_scalar "SELECT CAST(col_json AS String) FROM default.type_coverage WHERE id = 3")" "null" "NULL json"
assert_eq "$(ch_scalar "SELECT CAST(col_enum AS String) FROM default.type_coverage WHERE id = 3")" "null" "NULL enum"

log "Checking zero dates"
assert_eq "$(ch_scalar "SELECT CAST(col_date_zero AS String) FROM default.type_coverage WHERE id = 1")" "null" "zero date mapped to null"
assert_eq "$(ch_scalar "SELECT CAST(col_date_zero AS String) FROM default.type_coverage WHERE id = 2")" "1000-01-01" "minimum valid date preserved"

log "Checking JSON/type coverage payload"
json_row="$(ch_scalar "SELECT col_json FROM default.type_coverage WHERE id = 1")"
echo "$json_row" | rg '"name":"test"' >/dev/null 2>&1 || record_failure "JSON object missing name"
echo "$json_row" | rg '"nested":\{"key":1\}' >/dev/null 2>&1 || record_failure "JSON object missing nested payload"
assert_eq "$(ch_scalar "SELECT col_utf8_emoji FROM default.type_coverage WHERE id = 1")" "Hello 🦆 World 𝌆 Test" "UTF-8 emoji string"

log "Exercising CDC type compatibility"
docker exec "${MYSQL_CONTAINER}" mysql -h 127.0.0.1 -uroot "-p${MYSQL_ROOT_PASSWORD}" -D "${MYSQL_DB}" -e "
SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '');
INSERT INTO type_coverage_cdc (
  id, col_tinyint_signed, col_smallint, col_mediumint,
  col_int_unsigned, col_bigint_unsigned,
  col_double, col_decimal_5_0, col_decimal_20_10,
  col_char_10, col_tinytext, col_mediumtext, col_longtext,
  col_date, col_time, col_timestamp, col_datetime_6, col_year, col_set,
  col_json, col_enum, col_boolean, col_utf8_emoji, col_date_zero,
  created_at, updated_at
) VALUES (
  7001, -42, 1000, 500000,
  3000000000, 9999999999,
  2.71828, 12345, 9876543210.1234500000,
  'CDC-TEST', 'cdc tiny', 'cdc medium text', 'cdc long text',
  '2024-12-25', '14:30:00', '2025-06-15 12:00:00', '2025-06-15 12:00:00.123456', 2024, 'b,d',
  '{\"cdc\":true,\"items\":[1,2,3]}', 'beta', TRUE, 'CDC 🦆 emoji', '0000-00-00',
  NOW(), NOW()
);
"

wait_for_exact "SELECT COUNT(*) FROM default.type_coverage_cdc FINAL" "1" 45 || fail "CDC insert row count mismatch"
assert_eq "$(ch_scalar "SELECT col_tinyint_signed FROM default.type_coverage_cdc WHERE id = 7001")" "-42" "CDC tinyint"
assert_eq "$(ch_scalar "SELECT col_smallint FROM default.type_coverage_cdc WHERE id = 7001")" "1000" "CDC smallint"
assert_eq "$(ch_scalar "SELECT col_mediumint FROM default.type_coverage_cdc WHERE id = 7001")" "500000" "CDC mediumint"
assert_eq "$(ch_scalar "SELECT col_int_unsigned FROM default.type_coverage_cdc WHERE id = 7001")" "3000000000" "CDC unsigned int"
assert_eq "$(ch_scalar "SELECT col_bigint_unsigned FROM default.type_coverage_cdc WHERE id = 7001")" "9999999999" "CDC unsigned bigint"
assert_contains "$(ch_scalar "SELECT CAST(col_double AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "2.71828" "CDC double"
assert_decimal_eq "$(ch_scalar "SELECT col_decimal_5_0 FROM default.type_coverage_cdc WHERE id = 7001")" "12345" "CDC decimal"
assert_eq "$(ch_scalar "SELECT col_char_10 FROM default.type_coverage_cdc WHERE id = 7001")" "CDC-TEST" "CDC char"
assert_eq "$(ch_scalar "SELECT col_tinytext FROM default.type_coverage_cdc WHERE id = 7001")" "cdc tiny" "CDC tinytext"
assert_eq "$(ch_scalar "SELECT col_mediumtext FROM default.type_coverage_cdc WHERE id = 7001")" "cdc medium text" "CDC mediumtext"
assert_eq "$(ch_scalar "SELECT col_longtext FROM default.type_coverage_cdc WHERE id = 7001")" "cdc long text" "CDC longtext"
assert_eq "$(ch_scalar "SELECT CAST(col_date AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "2024-12-25" "CDC date"
assert_contains "$(ch_scalar "SELECT CAST(col_time AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "14:30:00" "CDC time"
assert_contains "$(ch_scalar "SELECT CAST(col_timestamp AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "2025-06-15 12:00:00" "CDC timestamp"
assert_contains "$(ch_scalar "SELECT CAST(col_datetime_6 AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "2025-06-15 12:00:00.123456" "CDC datetime(6)"
assert_eq "$(ch_scalar "SELECT col_year FROM default.type_coverage_cdc WHERE id = 7001")" "2024" "CDC year"
assert_eq "$(ch_scalar "SELECT col_set FROM default.type_coverage_cdc WHERE id = 7001")" "b,d" "CDC set"
assert_eq "$(ch_scalar "SELECT col_enum FROM default.type_coverage_cdc WHERE id = 7001")" "beta" "CDC enum"
assert_eq "$(ch_scalar "SELECT col_boolean FROM default.type_coverage_cdc WHERE id = 7001")" "1" "CDC boolean"
assert_eq "$(ch_scalar "SELECT CAST(col_date_zero AS String) FROM default.type_coverage_cdc WHERE id = 7001")" "null" "CDC zero date"
assert_eq "$(ch_scalar "SELECT col_utf8_emoji FROM default.type_coverage_cdc WHERE id = 7001")" "CDC 🦆 emoji" "CDC utf8 emoji"
cdc_json="$(ch_scalar "SELECT col_json FROM default.type_coverage_cdc WHERE id = 7001")"
echo "$cdc_json" | rg '"cdc":true' >/dev/null 2>&1 || record_failure "CDC JSON missing flag"
echo "$cdc_json" | rg '"items":\[1,2,3\]' >/dev/null 2>&1 || record_failure "CDC JSON missing items"

log "Exercising CDC updates/deletes"
docker exec "${MYSQL_CONTAINER}" mysql -h 127.0.0.1 -uroot "-p${MYSQL_ROOT_PASSWORD}" -D "${MYSQL_DB}" -e "
UPDATE type_coverage_cdc
SET col_smallint = 2000,
    col_char_10 = 'CDC-UPDATE',
    col_set = 'a,d',
    col_json = '{\"cdc\":false,\"items\":[4,5]}',
    updated_at = NOW()
WHERE id = 7001;
DELETE FROM type_coverage_cdc WHERE id = 7001;
"

wait_for_exact "SELECT COUNT(*) FROM default.type_coverage_cdc FINAL" "0" 45 || fail "CDC delete row count mismatch"

if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  echo ""
  echo "Type coverage mismatches (${#FAILURES[@]}):" >&2
  for item in "${FAILURES[@]}"; do
    echo " - ${item}" >&2
  done
  exit 1
fi

log "PeerDB type coverage test passed"
