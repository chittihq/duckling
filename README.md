![Duckling Banner](docs/images/banner.jpg)

# Duckling

ClickHouse-backed analytical replica for MySQL. Three-phase replication: duckling dumps the initial state into ClickHouse, then either **PeerDB** (real binlog CDC) or the **in-repo polling fallback** keeps it live.

## Why

- **Fast analytics** — ClickHouse MergeTree on top of OLTP data; columnar storage means group-bys and aggregates run 100–10,000× faster than the source MySQL.
- **Three-phase strategy** — duckling owns the consistent-snapshot dump and captures the source binlog position; Phase 2 picks up from there. No "PeerDB couldn't snapshot this giant table" outages.
- **CDC by default, polling when binlog isn't available** — the capability probe picks the right backend automatically per database. Sources without `REPLICATION SLAVE` (managed DBs, weird read replicas) still get replication via polling.
- **MySQL wire-protocol compatible** — BI tools, dashboards, and `mysql`-shell users talk to the replica with their existing drivers; queries run on ClickHouse under the hood.

## Quick start

```bash
docker-compose up -d                       # ClickHouse + duckling-server + frontend
# Wait for healthy, then create a database (auto-bootstraps by default):
curl -X POST http://localhost:3001/api/databases \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "LMS",
        "mysqlConnectionString": "mysql://user:pass@host:3306/lms",
        "replicationMode": "peerdb"
      }'
```

Frontend: <http://localhost:3000>. API: <http://localhost:3001>. MySQL wire protocol: `mysql -h 127.0.0.1 -P 3307 -u duckling -p${DUCKLING_API_KEY}`.

## Architecture

```
                    ┌─ Phase 1: duckling DumpService (always) ─┐
MySQL ──────────────┤                                          ├──── ClickHouse
                    │  - consistent snapshot                    │
                    │  - records binlog position before reads   │
                    │  - writes destination schema matching     │
                    │    chosen Phase-2 backend                 │
                    └───────────────────────────────────────────┘
                                       │
                       capability probe selects mode
                       │                                │
                  cdcSupported                     fallback
                       │                                │
                       ▼                                ▼
            ┌─ Phase 2A: PeerDB ──┐         ┌─ Phase 2B: polling ──┐
            │  doInitialSnapshot: │         │  CdcCompatibility    │
            │    false            │         │  Service: 1s row-    │
            │  resume from        │         │  count + change-     │
            │  recorded binlog    │         │  token diff polling  │
            └─────────────────────┘         └──────────────────────┘
```

Full design + open questions: [`docs/replication-strategy.md`](docs/replication-strategy.md).

## Repo layout

```
duckling/
├── packages/
│   ├── server/     # @chittihq/duckling-server — Express API + replication
│   ├── frontend/   # @chittihq/duckling-frontend — Nuxt 4 dashboard
│   ├── sdk/        # @chittihq/duckling — WebSocket SDK
│   └── shared/     # @chittihq/duckling-shared — types
├── docker-compose.yml          # Default dev stack (ClickHouse + server + UI)
├── docker-compose.peerdb.yml   # PeerDB stack (catalog, Temporal, workers, RustFS)
└── tests/integration/          # Full vitest e2e suite with PeerDB end-to-end
```

## Development

`pnpm` workspaces. Install once at repo root: `pnpm install`.

```bash
# Local server with hot reload, against compose'd ClickHouse + MySQL
docker compose up -d clickhouse
pnpm dev:server

# Tests
pnpm --filter @chittihq/duckling-server test       # unit
cd tests/integration && ./run.sh                   # full e2e (brings up PeerDB stack)
```

Source is baked into the duckling-server Docker image at build time, so `docker exec duckling-server pnpm run build:server` works even on hosts where Docker file-sharing is flaky. For hot reload against the container, rebuild after edits:

```bash
docker compose build clickhouse-server && docker compose up -d clickhouse-server
```

## Configuration

Copy `.env.example` → `.env`. Key settings:

- `MYSQL_CONNECTION_STRING` — source database
- `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` — target ClickHouse
- `REPLICATION_BACKEND` — global default for Phase 2 (`duckling` or `peerdb`); per-database `replicationMode` wins
- `SYNC_INTERVAL_MINUTES` — polling-mode incremental sync cadence (default 15)
- `PEERDB_*` and `RUSTFS_*` — only when using the PeerDB stack

Full list in `.env.example` and `packages/server/src/config.ts`.

## API surface

All `/api/*` endpoints require `Authorization: Bearer ${DUCKLING_API_KEY}`. Per-database routing via `?db=<id>`.

### Database management

- `GET|POST /api/databases` — list / create (POST auto-bootstraps unless `autoBootstrap: false`)
- `PUT|DELETE /api/databases/:id`
- `POST /api/databases/:id/test` — connection check

### Replication strategy

- `POST /api/databases/:id/bootstrap` — trigger Phase 1 (idempotent; `force` / `resume` flags supported)
- `GET /api/databases/:id/bootstrap/status` — per-table progress + recorded binlog position
- `GET /api/databases/:id/replication-mode` — capability probe result, pinned vs effective mode, known PeerDB caveats
- `POST /api/databases/:id/replication-mode` — pin or unset (`{ mode: 'peerdb'|'polling'|'none'|'auto' }`)

### Continuous replication

- `POST /cdc/start` / `POST /cdc/stop` — both route through the replication coordinator; start is idempotent for already-bootstrapped databases.
- `GET /cdc/status`

### Data access

- `POST /api/query` — arbitrary SQL
- `GET /api/tables` / `GET /api/tables/:name/schema` / `GET /api/tables/:name/data` / `GET /api/tables/:name/count`

## Benchmarks (20M rows)

Real numbers from the [benchmark suite](benchmark/):

| Query | MySQL | ClickHouse via duckling | Speedup |
|-------|-------|--------------------------|---------|
| Full table count | 4,258 ms | 4 ms | 1,064× |
| Filtered count | 1,475 ms | 20 ms | 73× |
| Group by status | 433,259 ms | 32 ms | 13,539× |
| Region × status breakdown | 16,685 ms | 112 ms | 148× |
| Monthly revenue (2023) | 7,536 ms | 30 ms | 251× |
| Regional analytics | 446,038 ms | 394 ms | 1,132× |
| **Total** | **909,251 ms** | **592 ms** | **1,535×** |

```bash
cd benchmark
pnpm run benchmark
```

## Known limitations

- **PeerDB MySQL zero-date corruption (UNRESOLVED)** — PeerDB's ClickHouse path silently corrupts MySQL `0000-00-00` and `1000-01-01` values, typically surfacing them as `1970-01-01`. **This is not fixed in this repo.** The capability probe surfaces it as a `knownBlockers` entry on `/api/databases/:id/replication-mode` so operators see it before adopting `peerdb` mode. Workarounds: (a) use `polling` mode — duckling normalizes zero-dates to `NULL`; (b) build a patched PeerDB image via `scripts/build-peerdb-zero-date-poc.sh` (POC patches in `docs/`); (c) accept the corruption. Upstream fix tracked in `docs/peerdb-upstream-zero-date-patch.md`.
- **PeerDB v0.36 rejects pre-populated destination tables** — the "duckling dumps then PeerDB attaches with `doInitialSnapshot: false`" handoff is implemented in code (`bootstrapTableForPeerDB`, `createMirror({ startPosition })`) but PeerDB rejects all variants we tried (`"not all PeerDB columns found"`). In `peerdb` mode today, PeerDB does the snapshot itself. Unblocking requires upstream PeerDB support for attach-to-existing or per-mirror `cdcStartingFromPosition`.
- **Mid-dump source writes during polling-mode Phase 1** — per-table reads aren't wrapped in a single MySQL transaction yet, so cross-table snapshots may be slightly inconsistent under active writes. Mitigation in polling mode: the next incremental sync picks up new rows. Not yet implemented.

## Docs

- [`CLAUDE.md`](CLAUDE.md) — orientation for Claude Code or anyone new to the codebase
- [`docs/replication-strategy.md`](docs/replication-strategy.md) — full three-phase design, open questions, implementation plan
- [`docs/peerdb-rustfs-migration-plan.md`](docs/peerdb-rustfs-migration-plan.md) — history of how we got here
- [`docs/peerdb-upstream-zero-date-patch.md`](docs/peerdb-upstream-zero-date-patch.md) — the zero-date workaround

## Contributing

Fork the repo, make a branch, open a PR. Add tests for new functionality.

## License

MIT. See LICENSE file.
