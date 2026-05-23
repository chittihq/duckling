# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a ClickHouse-backed analytical replica service that mirrors MySQL databases to ClickHouse for fast analytical queries.

Replication is structured around a per-database mode:

| `replicationMode` | Phase 1 (initial load) | Phase 2 (continuous) |
|-------------------|------------------------|----------------------|
| `peerdb`          | **PeerDB** (`doInitialSnapshot: true`). PeerDB v0.36's destination connector strictly validates pre-populated tables; we cannot hand a duckling-loaded table to PeerDB. The coordinator drops any polling-path leftovers (`<table>__raw` + projection view) and lets PeerDB create + populate. The capability probe records the source binlog position as diagnostic info; PeerDB tracks its own progress in its catalog. | **PeerDB** binlog CDC via flow API. Stack: catalog Postgres, flow workers, Temporal, RustFS for staging. |
| `polling`         | **duckling** `BootstrapService` (Phase 1 owner). Opens MySQL, captures binlog position via `captureBinlogPosition`, then per-table `forceFullSyncTable` writes the `<table>__raw` + projection-view layout. | **duckling** `CdcCompatibilityService` 1-second row-count + change-token polling. |
| `none`            | **duckling** `BootstrapService` (same as polling). | (none) — bootstrap-only deploys. |

Phase 2 is auto-detected from the capability probe (`log_bin`, `binlog_format`, `binlog_row_image`, `binlog_row_metadata`, `REPLICATION SLAVE/CLIENT`) unless pinned. **The "duckling dumps then PeerDB takes over from a captured position" handoff is not shipped today** — it is blocked on PeerDB upstream supporting attach-to-existing-table or per-mirror start position. See `docs/replication-strategy.md` for the full design + open questions.

The package name is still `@chittihq/duckling-server` for historical reasons; the runtime is ClickHouse.

## Monorepo Structure

This project uses **pnpm workspaces**:

```
duckling/
├── packages/
│   ├── server/          # @chittihq/duckling-server - ClickHouse sync + API server
│   ├── frontend/        # @chittihq/duckling-frontend - Nuxt 4 dashboard
│   ├── sdk/             # @chittihq/duckling - WebSocket SDK for queries
│   └── shared/          # @chittihq/duckling-shared - shared TypeScript types
├── pnpm-workspace.yaml
├── package.json
├── docker-compose.yml             # MySQL + ClickHouse + server + frontend (default dev stack)
└── docker-compose.peerdb.yml      # PeerDB stack (opt-in)
```

### Package Dependencies

- **server** depends on: `shared`
- **frontend** depends on: `shared`, `sdk`
- **sdk** depends on: `shared`
- **shared** has no dependencies

## Development Commands

### Package Management

- Use `pnpm` for all dependency management.
- `pnpm install` from the repo root installs every workspace.
- Add to a specific workspace: `pnpm --filter @chittihq/duckling-server add <pkg>`.

### Build & Development (Docker)

Run build/lint inside the running container:

```bash
# Build
docker exec duckling-server pnpm run build:server
docker exec duckling-frontend pnpm run build:frontend
docker exec duckling-server pnpm run build         # all workspaces

# Lint
docker exec duckling-server pnpm run lint
docker exec duckling-frontend pnpm run lint
```

Dev mode runs automatically via `docker-compose up -d` with hot reload (nodemon for server, Nuxt HMR for frontend). Do not `restart` containers for code changes — only rebuild when dependencies, Dockerfile, or compose file change.

### CLI (Server)

```bash
docker exec duckling-server node packages/server/dist/cli.js <command>
# health | sync | sync-incremental | status | validate | tables | query "<SQL>"
```

### MySQL passthrough utility

```bash
docker exec duckling-server node scripts/mysql.js "SELECT COUNT(*) FROM User"
```

### Ports

- Server: http://localhost:3001
- Frontend: http://localhost:3000
- ClickHouse HTTP: http://localhost:8123 (via the compose file)
- PeerDB UI (when `docker-compose.peerdb.yml` is up): http://localhost:13003

## Architecture Overview

```
MySQL (source)
  ├─► [duckling backend]   pnpm sync service polls + streams batches → ClickHouse MergeTree (__raw tables)
  │                                                                      └─► ReplacingMergeTree view (deduplicated read)
  └─► [peerdb backend]     PeerDB flow API mirrors via binlog CDC → ClickHouse MergeTree

ClickHouse storage layout per database:
  <db>.<table>__raw           — raw inserts (MergeTree)
  <db>.<table>                — projection view with row_number()/ReplacingMergeTree for read-side dedup
  <db>.sync_log               — sync run history (table, type, rows, status, duration_ms)
  <db>.appender_watermarks    — per-table watermark (last id / timestamp)
  <db>.full_sync_sessions     — resumable full-sync sessions
  <db>.cdc_binlog_position    — CdcCompatibilityService polling checkpoint
```

### Core components (server)

- `src/database/clickhouse.ts` — ClickHouse client wrapper. Uses native `query_params` for all parameterized queries. Owns DB-level bootstrap of internal tables.
- `src/database/mysql.ts` — MySQL connection pool + schema introspection.
- `src/database/databaseConfig.ts` — multi-database config persistence (`data/databases.json`).
- `src/services/clickhouseSyncService.ts` — full + incremental sync, watermark management, schema rebuilds, projection view, sync_log writes (with real `duration_ms`).
- `src/services/clickhouseAutomationService.ts` — periodic sync, real cleanup (OPTIMIZE on raw tables + sync_log pruning), real reconnection-based auto-restart.
- `src/services/cdcCompatibilityService.ts` — 1-second polling pseudo-CDC that fires per-table incremental syncs based on row-count and change-token deltas. Not real CDC; used when `REPLICATION_BACKEND=duckling` and the operator wants near-real-time updates without standing up PeerDB.
- `src/services/peerdbOrchestratorService.ts` + `peerdbSqlClient.ts` — creates source/target peers and mirrors via the PeerDB SQL/flow API. Active only when `REPLICATION_BACKEND=peerdb`.
- `src/server.ts` — Express app, REST API, request middleware that attaches per-database ClickHouse + MySQL clients.
- `src/services/mysqlProtocolServer.ts` + `mysqlQueryRouter.ts` + `mysqlResultFormatter.ts` — MySQL wire protocol server that maps incoming MySQL queries to ClickHouse.
- `src/services/websocketService.ts` — WebSocket query endpoint for the SDK.

### Multi-database support

Each MySQL source database gets its own logical ClickHouse database (`clickhouseDatabase` in `databases.json`) and its own MySQL connection pool, ClickHouse connection, sync service, and automation service (Map-keyed by `databaseId`). The `attachDatabaseContext` middleware (`src/middleware/database.ts`) resolves the `?db=<id>` query param on every request and attaches the right instances to `req`.

`databases.json` schema (lives at `data/databases.json` on the host):

```json
[
  {
    "id": "lms",
    "name": "LMS",
    "mysqlConnectionString": "mysql://user:pass@host:3306/chitti_lms",
    "clickhouseDatabase": "lms",
    "replicationMode": "peerdb",
    "bootstrap": {
      "status": "completed",
      "startedAt": "2026-05-23T...",
      "completedAt": "2026-05-23T...",
      "binlogPosition": {
        "mode": "gtid",
        "gtid": "0d4f...:1-12345"
      },
      "tableProgress": { "users": { "status": "completed", "recordsProcessed": 50000 } }
    },
    "peerdb": {
      "enabled": true
    },
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

Existing databases (predating the bootstrap field) are migrated on load: `bootstrap.status` is set to `'completed'` with no binlog position, so they keep using Phase 2B polling until an operator re-bootstraps to switch to Phase 2A.

### Replication backends

`REPLICATION_BACKEND` is the global default for Phase 2 (`duckling` for in-repo polling, `peerdb` for PeerDB CDC). Per-database overrides via `dbConfig.replicationMode` win. Phase 1 (bootstrap) is always handled by duckling regardless of backend.

#### Phase 1 — Bootstrap dump+ingest (always)

`ClickHouseSyncService.fullSync` (today) / `DumpService` (planned) opens a consistent-snapshot transaction on MySQL, records `(binlog file, position)` or GTID, then streams every table via keyset-paginated batches into ClickHouse MergeTree raw tables. The recorded binlog position is persisted in `dbConfig.bootstrap.binlogPosition` and later handed to PeerDB so Phase 2A can resume without re-snapshotting.

Watermark detection priority used during incremental syncs (and re-sync) is:

1. `updatedAt` / `updated_at` / `modifiedAt` / `modified_at`
2. `createdAt` / `created_at`
3. `timestamp`

Queries use `>=` (not `>`) on the watermark to avoid losing rows at the boundary. Re-processing the boundary row is idempotent because the raw tables use `ReplacingMergeTree`-style projection views for dedup.

#### Phase 2A — PeerDB CDC (binlog-capable MySQL)

Activated when:
- The capability probe sees `log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, `binlog_row_metadata=FULL`, and the MySQL user has `REPLICATION SLAVE` + `REPLICATION CLIENT` grants.
- `dbConfig.replicationMode` is `peerdb` (or absent and the probe says CDC is supported).

`peerdbOrchestratorService` creates a MySQL source peer, a ClickHouse target peer, and a per-table mirror via PeerDB's flow API. **PeerDB performs both the initial snapshot AND the CDC stream** (`doInitialSnapshot: true`) — see `replicationCoordinator.startPhase2` (the `mode === 'peerdb'` branch). The coordinator drops any leftover polling-path artifacts (`<table>` view + `<table>__raw` raw table) before mirror creation so PeerDB has a clean slate. The PeerDB stack (catalog Postgres, flow workers, Temporal, RustFS) must be running — bring it up with `docker-compose -f docker-compose.peerdb.yml up -d`.

**Why PeerDB owns the load rather than duckling:** PeerDB v0.36's ClickHouse destination connector strictly validates pre-populated tables. We implemented and tested a duckling-led bootstrap that writes a `ReplacingMergeTree(_peerdb_synced_at)` table with the full `_peerdb_*` metadata column set; PeerDB still rejects it with `"not all PeerDB columns found in destination table"`. Until upstream PeerDB supports attach-to-existing-table or a per-mirror `cdcStartingFromPosition` field, the duckling-dump → PeerDB-CDC handoff is unshippable. The capability probe still records the source binlog position for diagnostics + future migrations.

**Active blocker — MySQL zero dates:** PeerDB's ClickHouse path corrupts MySQL `0000-00-00` and `1000-01-01` values (typically surfaces as `1970-01-01`). The `docs/peerdb-upstream-zero-date-patch.md` doc describes the fix needed in upstream PeerDB; `docs/peerdb-upstream-zero-date-poc*.patch` and `scripts/build-peerdb-zero-date-poc.sh` provide a local POC for testing. **This is NOT solved by anything in this repo** — adopting `peerdb` mode against a source that may contain zero-dates currently requires either building the patched PeerDB image yourself, switching the source to `polling` mode (where duckling normalizes zero-dates to NULL), or accepting data corruption. The capability probe surfaces this as a `knownBlockers` entry on `/api/databases/:id/replication-mode` so operators see it before adopting peerdb.

#### Phase 2B — Polling fallback (no binlog CDC available)

Activated when the capability probe fails on the source MySQL (binlog disabled, wrong row image, missing grants) or when `dbConfig.replicationMode = 'polling'`.

`CdcCompatibilityService` (opt-in via `/cdc/start` API or `CDC_AUTO_START=true`) drives near-real-time updates by polling MySQL `getTableRowCount()` + `getTableChangeToken()` every second and triggering per-table incremental syncs when deltas appear. This is **not** real CDC — for binlog-based CDC, use Phase 2A.

### Automation (`ClickHouseAutomationService`)

Per-database service that runs three loops:

1. **Periodic sync** — runs `runSync()` every `SYNC_INTERVAL_MINUTES`. Default 15 min.
2. **Cleanup** — every `CLEANUP_INTERVAL_HOURS`:
   - `OPTIMIZE TABLE <raw> FINAL` on every raw MergeTree table.
   - Delete `sync_log` rows older than `RETENTION_DAYS` days.
3. **Health monitor** — every `monitoring.healthCheckInterval` ms, pings ClickHouse + MySQL. On failure, runs the real reconnect loop (`reconnectClickHouse()`, `reconnectMysql()`) with exponential backoff up to `MAX_RESTART_ATTEMPTS`. Successful recovery resumes the sync loop; exhausted recovery logs and disables the service.

S3 backups are not part of this branch. ClickHouse has native `BACKUP TO S3` support that can be wired up later, but no scheduled backup runs currently.

## Configuration

Configure via `.env` (copy from `.env.example`).

### Core

- `MYSQL_CONNECTION_STRING`
- `CLICKHOUSE_URL` (default `http://localhost:8123`)
- `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DATABASE`
- `REPLICATION_BACKEND` — `duckling` (default) or `peerdb`
- `PORT` (server HTTP, default 3000)
- `DUCKLING_API_KEY` — required for `/api/*` programmatic access

### Sync

- `SYNC_INTERVAL_MINUTES` (default 15)
- `BATCH_SIZE` (default 1000) / `FULL_SYNC_BATCH_SIZE`
- `ENABLE_INCREMENTAL_SYNC` (default true)
- `AUTO_START_SYNC` (default true)
- `EXCLUDED_TABLES` (comma-separated)
- `MAX_RETRIES` (default 3)

### Automation

- `AUTO_CLEANUP` (default true) / `CLEANUP_INTERVAL_HOURS` (default 24) / `RETENTION_DAYS` (default 90)
- `AUTO_RESTART` (default true) / `MAX_RESTART_ATTEMPTS` (default 3)

### CDC compatibility

- `CDC_ENABLED` (default false)
- `CDC_AUTO_START` (default false)

### PeerDB (when `REPLICATION_BACKEND=peerdb`)

- `PEERDB_API_URL`, `PEERDB_UI_URL`, `PEERDB_API_KEY`
- `PEERDB_SQL_HOST` / `PEERDB_SQL_PORT` / `PEERDB_SQL_USER` / `PEERDB_SQL_PASSWORD`
- `PEERDB_CLICKHOUSE_HOST` / `PEERDB_CLICKHOUSE_PORT` / `PEERDB_CLICKHOUSE_TLS`
- `PEERDB_MIRROR_PREFIX`, `PEERDB_MYSQL_DISABLE_TLS`, `PEERDB_MYSQL_FLAVOR`
- `PEERDB_NEXTAUTH_SECRET` — override the dev-only default for the PeerDB UI

### RustFS (PeerDB staging)

- `RUSTFS_ENDPOINT`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_REGION`, `RUSTFS_BUCKET`

## API Endpoints

All `/api/*` endpoints require auth via `Authorization: Bearer <DUCKLING_API_KEY>` or a session cookie from `/api/login`. Endpoints accept `?db=<id>` for multi-database routing.

### Health & status

- `GET /health` / `GET /status` / `GET /metrics`

### Database management

- `GET|POST|PUT|DELETE /api/databases` and `/api/databases/:id`
- `POST /api/databases/:id/test`

### Bootstrap (Phase 1)

- `POST /api/databases/:id/bootstrap` — trigger initial dump+ingest. Body: `{ force?: boolean, resume?: boolean }`.
- `GET /api/databases/:id/bootstrap/status` — per-table progress + captured binlog position.
- `GET /api/databases/:id/replication-mode` — capability probe result + currently-selected Phase 2 mode.

### Sync

- `POST /api/sync/full` — alias for bootstrap when `bootstrap.status === 'pending'`; otherwise a no-op idempotent refresh (use `?force=true` to redo the dump).
- `POST /api/sync/incremental` — manual nudge for Phase 2B polling.
- `POST /api/sync/table/:tableName` — single-table re-dump.
- `GET /api/sync/status` / `GET /api/sync/validate`

### Automation

- `GET /automation/status` / `POST /automation/start` / `POST /automation/stop` / `POST /automation/cleanup`

### CDC compatibility (polling)

- `GET /cdc/status` / `POST /cdc/start` / `POST /cdc/stop`

### Data

- `GET /api/tables` / `GET /api/tables/:name/schema` / `GET /api/tables/:name/count`
- `GET /api/tables/:name/data?limit=&offset=`
- `POST /api/query` — arbitrary SQL on ClickHouse

## Tests

### Unit tests

Vitest. Run inside the server container: `docker exec duckling-server pnpm test`. Test files live in `packages/server/src/**/__tests__/`.

### Integration tests

The integration harness in `tests/integration/` spins up MySQL + ClickHouse + the server (and optionally PeerDB) and runs the vitest suites:

```bash
cd tests/integration
./run.sh
```

`tests/integration/docker-compose.yml` defines the stack. The harness now runs against ClickHouse exclusively; suite names map to:

- `suite1-full-sync.test.ts`
- `suite2-incremental-insert.test.ts`
- `suite3-incremental-update.test.ts`
- `suite4-single-table-sync.test.ts`
- `suite5-idempotent-resync.test.ts`
- `suite6-cdc-realtime.test.ts` — exercises `CdcCompatibilityService` polling
- `suite7-type-fidelity.test.ts` — type round-trips; the zero-date assertion is backend-aware (relaxed under PeerDB pending the upstream patch)
- `suite8-composite-primary-key.test.ts`
- `suite9-benchmarks.test.ts`
- `suite10-mysql-protocol-compat.test.ts`
- `suite11-sdk-integration.test.ts`
- `suite12-sdk-registry-install.test.ts`
- `suite13-interrupted-incremental-restart.test.ts`
- `suite14-incremental-crash-probe.test.ts`
- `suite15-clear-all-data.test.ts`

Server port for the integration stack is **3002** (avoids collision with a running dev instance on 3001).

### PeerDB type-coverage harness

`tests/peerdb/run-type-coverage.sh` brings up the PeerDB stack, seeds `tests/peerdb/mysql-seed-type-coverage.sql`, and asserts MySQL→ClickHouse type fidelity via PeerDB mirrors. Known PeerDB blockers (zero-date, `1000-01-01`) are recorded via `record_known_blocker` rather than failing the run.

## Code Style

- TypeScript with strict mode off for flexibility.
- Async/await everywhere; no callback-style.
- Multi-instance pattern (Map per `databaseId`) for `ClickHouseConnection`, `MySQLConnection`, `ClickHouseSyncService`, `ClickHouseAutomationService`, `CdcCompatibilityService`.
- All ClickHouse queries with parameters use the wrapper in `database/clickhouse.ts`, which routes through native `query_params`. Avoid string interpolation of user input.
- Express middleware pattern for auth, rate limiting, and database context.

## Production deployment

The default stack uses Docker Compose. `docker/server.Dockerfile` builds the production image. Health endpoints are at `/health` and `/status`.
