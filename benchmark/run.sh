#!/usr/bin/env bash
# ============================================================
# Duckling Benchmark: MySQL vs DuckDB (20M rows)
#
# Usage:
#   ./run.sh                   # Full benchmark (20M rows)
#   BENCHMARK_SCALE=0.1 ./run.sh  # Quick test (2M rows)
#   BENCHMARK_SCALE=0.01 ./run.sh # Smoke test (200K rows)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --------------- Configuration ---------------
API_KEY="benchmark-api-key"
API_URL="http://localhost:3001"
DB_ID="benchmark"
SCALE="${BENCHMARK_SCALE:-1}"
BATCHES=$(echo "$SCALE * 2000" | bc | cut -d. -f1)
EXPECTED_ROWS=$(echo "$BATCHES * 10000" | bc | cut -d. -f1)

# --------------- Colors ---------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --------------- Results tracking ---------------
QUERY_NAMES=()
MYSQL_TIMES=()
DUCKDB_TIMES=()
SPEEDUPS=()

# --------------- Helpers ---------------
log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }
hr()   { echo -e "${DIM}$(printf '─%.0s' $(seq 1 60))${NC}"; }
fmt_num() { echo "$1" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta'; }

cleanup() {
  echo ""
  log "Cleaning up..."
  docker compose down -v 2>/dev/null || true
  # Docker containers may create files as root; try sudo if available
  if command -v sudo &>/dev/null; then
    sudo rm -rf data/ 2>/dev/null || rm -rf data/ 2>/dev/null || true
  else
    rm -rf data/ 2>/dev/null || true
  fi
  log "Done."
}
trap cleanup EXIT

check_deps() {
  local missing=0
  for cmd in docker jq bc curl sed; do
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

wait_for_url() {
  local url="$1" max_wait="${2:-120}" elapsed=0
  while ! curl -sf "$url" -H "Authorization: ${API_KEY}" > /dev/null 2>&1; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$max_wait" ]; then
      fail "Timeout waiting for $url (${max_wait}s)"
      exit 1
    fi
  done
}

run_query() {
  local name="$1"
  local sql="$2"

  echo -e "\n${BOLD}${name}${NC}"
  echo -e "  ${DIM}${sql}${NC}"

  # Build JSON payload using jq for safe escaping
  local payload_mysql payload_duck
  payload_mysql=$(jq -n --arg sql "$sql" '{"sql": $sql, "database": "mysql"}')
  payload_duck=$(jq -n --arg sql "$sql" '{"sql": $sql, "database": "duckdb"}')

  # Query MySQL (via Duckling proxy)
  local mysql_response mysql_time mysql_ms
  mysql_response=$(curl -sf --max-time 600 -w '\n%{time_total}' \
    -X POST "${API_URL}/api/query?db=${DB_ID}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload_mysql" 2>&1) || { fail "MySQL query failed"; return; }
  mysql_time=$(echo "$mysql_response" | tail -1)
  mysql_ms=$(echo "$mysql_time * 1000" | bc | cut -d. -f1)

  # Query DuckDB
  local duck_response duck_time duck_ms
  duck_response=$(curl -sf --max-time 600 -w '\n%{time_total}' \
    -X POST "${API_URL}/api/query?db=${DB_ID}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload_duck" 2>&1) || { fail "DuckDB query failed"; return; }
  duck_time=$(echo "$duck_response" | tail -1)
  duck_ms=$(echo "$duck_time * 1000" | bc | cut -d. -f1)

  # Calculate speedup
  local speedup="N/A"
  if [ "${duck_ms:-0}" -gt 0 ] 2>/dev/null; then
    speedup=$(echo "scale=1; $mysql_ms / $duck_ms" | bc 2>/dev/null || echo "N/A")
  fi

  printf "  ${RED}MySQL:  %6d ms${NC}\n" "$mysql_ms"
  printf "  ${GREEN}DuckDB: %6d ms${NC}\n" "$duck_ms"
  echo -e "  ${BOLD}Speedup: ${speedup}x 🚀${NC}"

  # Track results
  QUERY_NAMES+=("$name")
  MYSQL_TIMES+=("$mysql_ms")
  DUCKDB_TIMES+=("$duck_ms")
  SPEEDUPS+=("$speedup")
}

print_summary() {
  echo ""
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${CYAN}  BENCHMARK SUMMARY${NC}"
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════════════${NC}"
  echo ""
  printf "  ${BOLD}%-35s %10s %10s %8s${NC}\n" "Query" "MySQL" "DuckDB" "Speedup"
  hr
  local total_mysql=0 total_duck=0
  for i in "${!QUERY_NAMES[@]}"; do
    printf "  %-35s %8s ms %8s ms %6sx\n" \
      "${QUERY_NAMES[$i]}" "${MYSQL_TIMES[$i]}" "${DUCKDB_TIMES[$i]}" "${SPEEDUPS[$i]}"
    total_mysql=$((total_mysql + ${MYSQL_TIMES[$i]:-0}))
    total_duck=$((total_duck + ${DUCKDB_TIMES[$i]:-0}))
  done
  hr

  local avg_speedup="N/A"
  if [ "$total_duck" -gt 0 ]; then
    avg_speedup=$(echo "scale=1; $total_mysql / $total_duck" | bc 2>/dev/null || echo "N/A")
  fi
  printf "  ${BOLD}%-35s %8s ms %8s ms %6sx${NC}\n" "TOTAL" "$total_mysql" "$total_duck" "$avg_speedup"
  echo ""

  # Write markdown results for CI
  {
    echo "## Benchmark Results"
    echo ""
    echo "**Scale:** ${SCALE}x (${EXPECTED_ROWS} order rows)"
    echo ""
    echo "| Query | MySQL (ms) | DuckDB (ms) | Speedup |"
    echo "|-------|-----------|------------|---------|"
    for i in "${!QUERY_NAMES[@]}"; do
      echo "| ${QUERY_NAMES[$i]} | ${MYSQL_TIMES[$i]} | ${DUCKDB_TIMES[$i]} | ${SPEEDUPS[$i]}x |"
    done
    echo "| **TOTAL** | **${total_mysql}** | **${total_duck}** | **${avg_speedup}x** |"
  } > benchmark-results.md

  ok "Results saved to benchmark-results.md"
}

# ===============================================================
# MAIN
# ===============================================================

main() {
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║              Duckling Benchmark Suite                        ║${NC}"
  echo -e "${BOLD}${CYAN}║         MySQL vs DuckDB · $(fmt_num "$EXPECTED_ROWS") rows                  ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # Prerequisites
  check_deps

  # ------- Step 1: Prepare data directory -------
  log "[1/6] Preparing environment..."
  rm -rf data/
  mkdir -p data
  cat > data/databases.json << EOJSON
[
  {
    "id": "${DB_ID}",
    "name": "Benchmark",
    "mysqlConnectionString": "mysql://benchmark:benchmarkpass@mysql:3306/benchmark_db",
    "duckdbPath": "data/benchmark.db",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
EOJSON
  ok "Environment ready (scale=${SCALE}, batches=${BATCHES})"

  # ------- Step 2: Start MySQL -------
  log "[2/6] Starting MySQL..."
  docker compose up -d mysql
  echo -n "  Waiting for MySQL health check"
  until docker compose exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -prootpass --silent 2>/dev/null; do
    echo -n "."
    sleep 2
  done
  echo ""
  ok "MySQL is ready"

  # ------- Step 3: Seed data -------
  log "[3/6] Seeding data (${BATCHES} batches × 10,000 = $(fmt_num "$EXPECTED_ROWS") order rows)..."
  local seed_start seed_end seed_duration
  seed_start=$(date +%s)

  # Replace batch count placeholder and pipe to MySQL (use root for CREATE PROCEDURE privilege)
  sed "s/SEED_BATCH_COUNT/${BATCHES}/g" seed.sql \
    | docker compose exec -T mysql mysql -h 127.0.0.1 -uroot -prootpass benchmark_db

  seed_end=$(date +%s)
  seed_duration=$((seed_end - seed_start))
  ok "Seeding complete in ${seed_duration}s"

  # ------- Step 4: Start Duckling -------
  log "[4/6] Starting Duckling server..."
  docker compose up -d duckling
  echo -n "  Waiting for Duckling health check"
  local duckling_wait=0
  until curl -sf "${API_URL}/health?db=${DB_ID}" -H "Authorization: ${API_KEY}" > /dev/null 2>&1; do
    echo -n "."
    sleep 3
    duckling_wait=$((duckling_wait + 3))
    if [ "$duckling_wait" -ge 180 ]; then
      fail "Duckling failed to start within 180s"
      docker compose logs duckling | tail -50
      exit 1
    fi
  done
  echo ""
  ok "Duckling is ready"

  # ------- Step 5: Sync MySQL → DuckDB -------
  log "[5/6] Syncing MySQL → DuckDB..."
  local sync_start sync_end sync_duration
  sync_start=$(date +%s)

  local sync_result
  sync_result=$(curl -sf --max-time 3600 -X POST "${API_URL}/sync/full?db=${DB_ID}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json")

  sync_end=$(date +%s)
  sync_duration=$((sync_end - sync_start))

  echo "$sync_result" | jq -r '
    if .results then
      .results[] | "  \(.table): \(.recordsProcessed // "?") rows in \(.duration // "?")ms"
    elif .error then
      "  Error: \(.error)"
    else
      .
    end
  ' 2>/dev/null || echo "  $sync_result"

  ok "Sync complete in ${sync_duration}s"

  # Verify DuckDB row counts
  log "Verifying sync..."
  local verify
  verify=$(curl -sf --max-time 60 -X POST "${API_URL}/api/query?db=${DB_ID}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"sql": "SELECT '\''orders'\'' AS tbl, COUNT(*) AS cnt FROM orders UNION ALL SELECT '\''users'\'', COUNT(*) FROM users UNION ALL SELECT '\''products'\'', COUNT(*) FROM products", "database": "duckdb"}')
  echo "$verify" | jq -r '.result[] | "  \(.tbl): \(.cnt) rows"' 2>/dev/null || echo "  $verify"

  # ------- Step 6: Run Benchmarks -------
  log "[6/6] Running benchmark queries..."
  hr

  run_query "Q1: Full table count" \
    "SELECT COUNT(*) AS cnt FROM orders"

  run_query "Q2: Filtered count" \
    "SELECT COUNT(*) AS cnt FROM orders WHERE status = 'shipped'"

  run_query "Q3: Group by status" \
    "SELECT status, COUNT(*) AS cnt, ROUND(AVG(total_amount), 2) AS avg_amt FROM orders GROUP BY status ORDER BY cnt DESC"

  run_query "Q4: Region × status breakdown" \
    "SELECT region, status, COUNT(*) AS cnt, ROUND(SUM(total_amount), 2) AS total FROM orders GROUP BY region, status ORDER BY total DESC LIMIT 20"

  run_query "Q5: Monthly revenue (2023)" \
    "SELECT YEAR(order_date) AS yr, MONTH(order_date) AS mo, COUNT(*) AS cnt, ROUND(SUM(total_amount), 2) AS revenue FROM orders WHERE order_date >= '2023-01-01' AND order_date < '2024-01-01' GROUP BY yr, mo ORDER BY yr, mo"

  run_query "Q6: Top 10 spenders" \
    "SELECT user_id, COUNT(*) AS order_count, ROUND(SUM(total_amount), 2) AS total_spent FROM orders GROUP BY user_id ORDER BY total_spent DESC LIMIT 10"

  run_query "Q7: Regional analytics" \
    "SELECT region, COUNT(*) AS cnt, ROUND(SUM(total_amount), 2) AS total, ROUND(AVG(total_amount), 2) AS avg_amt, ROUND(MIN(total_amount), 2) AS min_amt, ROUND(MAX(total_amount), 2) AS max_amt, COUNT(DISTINCT user_id) AS unique_users FROM orders WHERE order_date BETWEEN '2022-01-01' AND '2023-12-31' GROUP BY region ORDER BY total DESC"

  run_query "Q8: Join users + orders" \
    "SELECT u.region, COUNT(*) AS cnt, ROUND(SUM(o.total_amount), 2) AS total FROM orders o JOIN users u ON o.user_id = u.id GROUP BY u.region ORDER BY total DESC"

  # ------- Summary -------
  print_summary

  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║                   Benchmark Complete! 🎉                     ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  Seed time: ${seed_duration}s | Sync time: ${sync_duration}s"
  echo ""
}

main "$@"
