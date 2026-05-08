#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${ROOT_DIR}/docker-compose.peerdb.yml"
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

cleanup() {
  docker rm -f "${MYSQL_CONTAINER}" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}

trap cleanup EXIT

log "Resetting PeerDB stack"
cleanup

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
docker exec duckling-peerdb-catalog sh -lc "PGPASSWORD=peerdb psql -h duckling-peerdb-server -p 9900 -U peerdb -d peerdb -c \"DROP MIRROR IF EXISTS duckling_default_users; DROP MIRROR IF EXISTS mysql_to_ch_users;\"" >/dev/null 2>&1 || true
docker exec duckling-peerdb-catalog psql -U postgres -d postgres -c "DELETE FROM flows WHERE name IN ('duckling_default_users','mysql_to_ch_users'); DELETE FROM peers WHERE name IN ('mysql_default','clickhouse_default');" >/dev/null
docker exec duckling-peerdb-clickhouse clickhouse-client --query "DROP TABLE IF EXISTS default.users; DROP TABLE IF EXISTS default._peerdb_raw_duckling_default_users; DROP TABLE IF EXISTS default._peerdb_raw_mysql_to_ch_users; DROP TABLE IF EXISTS default.users__raw;" >/dev/null 2>&1 || true

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
for _ in $(seq 1 60); do
  if docker exec "${MYSQL_CONTAINER}" mysqladmin -uroot "-p${MYSQL_ROOT_PASSWORD}" ping >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker exec "${MYSQL_CONTAINER}" mysql -uroot "-p${MYSQL_ROOT_PASSWORD}" -e \
  "GRANT REPLICATION SLAVE, REPLICATION CLIENT, SELECT, SHOW VIEW, EVENT, TRIGGER ON *.* TO '${MYSQL_USER}'@'%'; FLUSH PRIVILEGES;"

log "Seeding MySQL source"
docker exec "${MYSQL_CONTAINER}" mysql -uroot "-p${MYSQL_ROOT_PASSWORD}" -D "${MYSQL_DB}" -e "
CREATE TABLE users (
  id INT PRIMARY KEY,
  name VARCHAR(255),
  metadata JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
REPLACE INTO users (id, name, metadata) VALUES
  (1, 'Alice', JSON_OBJECT('role','admin')),
  (2, 'Bob', JSON_OBJECT('role','user'));
"

log "Waiting for Duckling runtime API"
for _ in $(seq 1 60); do
  if docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/status?db=default', {
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "Triggering PeerDB-backed full sync"
sync_ok=0
for _ in $(seq 1 20); do
  if docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/full?db=default', {
  method: 'POST',
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then(async (r) => {
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  console.log(text);
}).catch((err) => { console.error(err); process.exit(1); });
"; then
    sync_ok=1
    break
  fi
  sleep 3
done

[[ "$sync_ok" == "1" ]] || fail "PeerDB-backed full sync never became ready"

log "Waiting for mirror to become visible"
for _ in $(seq 1 30); do
  status_json="$(docker exec duckling-peerdb-runtime node -e "
fetch('http://127.0.0.1:3000/sync/status?db=default', {
  headers: { Authorization: 'Bearer ${API_KEY}' }
}).then(async (r) => console.log(await r.text())).catch((err) => { console.error(err); process.exit(1); });
")"
  if echo "$status_json" | rg '"mirrored":1' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "$status_json" | rg '"mirrored":1' >/dev/null 2>&1 || fail "Mirror was not reported as active"

log "Checking initial snapshot in ClickHouse"
initial_rows="$(docker exec duckling-peerdb-clickhouse clickhouse-client --query "SELECT id, name FROM default.users FINAL ORDER BY id FORMAT TSV")"
[[ "$initial_rows" == $'1\tAlice\n2\tBob' ]] || fail "Unexpected initial ClickHouse rows: ${initial_rows}"

log "Applying MySQL CDC changes"
docker exec "${MYSQL_CONTAINER}" mysql -uroot "-p${MYSQL_ROOT_PASSWORD}" -D "${MYSQL_DB}" -e "
INSERT INTO users (id, name, metadata) VALUES (3, 'Cara', JSON_OBJECT('role','editor'));
UPDATE users SET name='Bobby', metadata=JSON_OBJECT('role','power-user') WHERE id=2;
DELETE FROM users WHERE id=1;
"

log "Waiting for ClickHouse CDC results"
for _ in $(seq 1 45); do
  final_rows="$(docker exec duckling-peerdb-clickhouse clickhouse-client --query "SELECT id, name FROM default.users FINAL ORDER BY id FORMAT TSV")"
  if [[ "$final_rows" == $'2\tBobby\n3\tCara' ]]; then
    break
  fi
  sleep 2
done

[[ "$final_rows" == $'2\tBobby\n3\tCara' ]] || fail "Unexpected final ClickHouse rows: ${final_rows}"

log "PeerDB smoke test passed"
