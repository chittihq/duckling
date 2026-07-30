![Duckling Banner](docs/images/banner.jpg)

# Duckling

ClickHouse-backed analytical replica for MySQL. Replication is per-database, picked from a capability probe (or pinned by the operator), with two backends today:

- **`peerdb`** — **PeerDB end-to-end**: it does the full initial snapshot itself and continues into binlog streaming as one continuous operation; duckling never touches the data. Requires PeerDB stack (Temporal, flow workers, RustFS, catalog Postgres).
- **`polling`** — duckling dumps the source, then a 1-second row-count + change-token poller fires incremental syncs, augmented by **CDC-lite**: a lightweight binlog tailer that tombstones deletes and triggers immediate syncs. Works even where full CDC can't (e.g. `binlog_row_metadata=MINIMAL` on managed MySQL). No PeerDB dependency. The fallback when the source doesn't qualify for `peerdb` mode.

A duckling-led dump-then-PeerDB-attach handoff (so duckling owns Phase 1 even in peerdb mode) is implemented in code but currently blocked upstream — PeerDB v0.36 rejects pre-populated destination tables. See `docs/replication-strategy.md`.

## Why

- **Fast analytics** — ClickHouse MergeTree on top of OLTP data; columnar storage means group-bys and aggregates run 100–10,000× faster than the source MySQL.
- **Mode picked per database** — the capability probe checks the source's binlog setup and grants and recommends `peerdb` or `polling`. Operators can pin via `POST /api/databases/:id/replication-mode`.
- **Bootstrap state is uniform across modes** — `bootstrap.status` on `databases.json` reflects "data is loaded" regardless of whether PeerDB or duckling did the loading. The replication coordinator is the single orchestration point.
- **MySQL wire-protocol compatible** — BI tools, dashboards, and `mysql`-shell users talk to the replica with their existing drivers; queries run on ClickHouse under the hood.
- **S3 backups** — ClickHouse-native `BACKUP TO S3(...)` / `RESTORE` against AWS S3 or any S3-compatible store (MinIO, R2, B2, RustFS, DigitalOcean Spaces). Scheduled or manual.

## Quick start

```bash
docker compose up -d                       # published image + ClickHouse (see Deploy below)
# For local development with hot reload instead:
#   docker compose -f docker-compose.dev.yml up -d
# Wait for healthy, then create a database (auto-bootstraps by default):
curl -X POST http://localhost:3000/api/databases \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "LMS",
        "mysqlConnectionString": "mysql://user:pass@host:3306/lms",
        "replicationMode": "peerdb"
      }'
```

Dashboard + API: <http://localhost:3000> (same origin). MySQL wire protocol: `mysql -h 127.0.0.1 -P 3307 -u duckling -p${DUCKLING_API_KEY}`. (Dev stack splits them: dashboard on 3000, API on 3001.)

### Single-port mode (HTTP + MySQL on one port)

Set `MYSQL_PROTOCOL_SHARED_PORT=true` and the MySQL wire protocol rides the HTTP port (3000) instead of its own — one published port total:

```bash
curl http://SERVER_IP:3000/health                      # HTTP, same as always
mysql -h SERVER_IP -P 3000 -u duckling -p${DUCKLING_API_KEY}   # MySQL, same port
```

Detection works because the two protocols initiate differently: HTTP clients send first, MySQL clients silently wait for the server greeting. A connection that stays quiet for `MYSQL_PROTOCOL_DETECTION_TIMEOUT_MS` (default 50 ms) is treated as MySQL. Dashboard, API, and WebSocket are unaffected.

> **Reach it via `IP:port`, not a proxy domain.** The MySQL wire protocol is raw TCP — HTTP reverse proxies (Traefik/Nginx/Dokploy domains) only route HTTP, so MySQL clients must connect directly to the server's IP and port in either mode. Single-port mode just means that direct address is the same port the dashboard uses. Off by default; when off, ports stay separate (3000 + 3307) exactly as before.

## Deploy (self-host)

For a server deploy, use the **published image** (`chittihq/duckling`, built from the single-container `Dockerfile` — API + dashboard on one port) plus ClickHouse **and the PeerDB CDC stack**. The default [`docker-compose.yml`](docker-compose.yml) is exactly that:

```bash
curl -O https://raw.githubusercontent.com/chittihq/duckling/main/docker-compose.yml
docker compose up -d
```

That's it — **no environment variables required**:

- **ClickHouse is bundled and auto-connected** (you never configure it).
- **PeerDB (real binlog CDC) is bundled and is the primary mode** — CDC-capable MySQL sources stream via binlog automatically; sources without binlog CDC fall back to polling. The flow images are chittihq's zero-date-patched PeerDB builds, so MySQL `0000-00-00` values survive as `NULL` instead of corrupting.
- **Persistence uses named volumes** (`clickhouse-data`, `duckling-data`, `catalog-data`, `rustfs-data`) — nothing to map by hand, works the same under the Compose CLI or Dokploy's Compose deploy.
- **Secrets auto-generate on first boot** (admin password, API key, session secret) and are printed once in the logs:
  ```bash
  docker compose logs duckling | grep -A6 generated
  ```
- **Sizing**: the PeerDB stack (Temporal, catalog Postgres, flow workers, RustFS) wants ~4 GB RAM on top of duckling + ClickHouse. Small host, polling is enough? Remove the PeerDB services from the compose and pin databases to `replicationMode: 'polling'`.
- Debug UIs are off by default: `docker compose --profile debug up -d` adds the PeerDB UI (`:13003`) and Temporal UI (`:18233`).

Then open <http://SERVER_IP:3000>, log in, and **add your MySQL database from the dashboard** (or `POST /api/databases`) — the connection string is stored per-database on the `duckling-data` volume, so you don't bake it into the compose. Set `MYSQL_CONNECTION_STRING` in the compose only if you want a single default database created automatically. Behind a reverse proxy, set `TRUST_PROXY=1`.

> This container is **not** self-contained like the old DuckDB build — ClickHouse is a separate service reached over `CLICKHOUSE_URL`. The compose wires that for you; the volume that holds your data is ClickHouse's `clickhouse-data` (`/var/lib/clickhouse`).

## Architecture

```
                            capability probe + per-DB replicationMode
                            │                                  │
                       peerdb mode                       polling / none mode
                            │                                  │
                            ▼                                  ▼
              ┌─ PeerDB (Phase 1 + 2) ─┐         ┌─ duckling BootstrapService ┐
MySQL ────────┤  doInitialSnapshot:    ├──CH─────┤  - keyset-paginated dump   ├── ClickHouse
              │    true                │         │  - records binlog position │
              │  binlog CDC stream     │         │  - writes <table>__raw +   │
              │  via flow API          │         │    projection view         │
              └────────────────────────┘         └──────────────┬─────────────┘
                                                                ▼
                                                  ┌─ CdcCompatibilityService ─┐
                                                  │  1s row-count + change-   │
                                                  │  token diff polling       │
                                                  │  (only if CDC enabled)    │
                                                  └───────────────────────────┘
```

> **Note:** A "duckling dumps then PeerDB resumes from the captured binlog
> position" handoff is plumbed in code but **does not ship today** — PeerDB
> v0.36's destination connector rejects pre-populated tables. Track the
> upstream blocker in `docs/replication-strategy.md`.

Full design + open questions: [`docs/replication-strategy.md`](docs/replication-strategy.md).

## Repo layout

```
duckling/
├── packages/
│   ├── server/     # @chittihq/duckling-server — Express API + replication
│   ├── frontend/   # @chittihq/duckling-frontend — Nuxt 4 dashboard
│   ├── sdk/        # @chittihq/duckling — WebSocket SDK
│   └── shared/     # @chittihq/duckling-shared — types
├── docker-compose.yml          # DEFAULT: self-host deploy (published image + ClickHouse + PeerDB CDC stack)
├── docker-compose.dev.yml      # Dev stack (source builds + hot reload: ClickHouse + server + UI)
├── docker-compose.peerdb.yml   # Dev/integration PeerDB stack (used by scripts/peerdb-up.sh + tests)
└── tests/integration/          # Full vitest e2e suite with PeerDB end-to-end
```

## Development

`pnpm` workspaces. Install once at repo root: `pnpm install`.

Development uses the **dev stack** (`docker-compose.dev.yml` — source builds + hot reload), not the default deploy compose:

```bash
# Full dev stack: ClickHouse + server (nodemon) + frontend (Nuxt HMR)
docker compose -f docker-compose.dev.yml up -d

# Or just ClickHouse, with the server running on the host:
docker compose -f docker-compose.dev.yml up -d clickhouse
pnpm dev:server

# Tests
pnpm --filter @chittihq/duckling-server test       # unit
cd tests/integration && ./run.sh                   # full e2e (brings up PeerDB stack)
```

Source is baked into the duckling-server Docker image at build time, so `docker exec duckling-server pnpm run build:server` works even on hosts where Docker file-sharing is flaky. For hot reload against the container, rebuild after edits:

```bash
docker compose -f docker-compose.dev.yml build clickhouse-server && docker compose -f docker-compose.dev.yml up -d clickhouse-server
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

All `/api/*` endpoints require `Authorization: Bearer <token>`. Per-database routing via `?db=<id>`. Tokens are the global `DUCKLING_API_KEY` (superuser), a JWT session, or a **per-database API key** (`dk_…`) minted at `POST /api/databases/:id/api-keys` / the `/api-keys` dashboard page — scoped to one database's data plane (query/sync/cdc) and 403'd everywhere else. Per-db keys are stored hash-only and served from an in-memory index (no per-request disk I/O).

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
- **Polling-mode delete blind spot (mitigated by CDC-lite)** — the poller triggers a full table rebuild only when the row count *decreases*, and incremental syncs never remove rows, so historically a count-neutral delete+insert left the deleted row visible until the next full rebuild. **CDC-lite** (a lightweight binlog tailer, enabled automatically per database whenever the source has ROW binlogs + replication grants — no flag) now closes this: it writes delete tombstones and nudges immediate per-table syncs, and works even with `binlog_row_metadata=MINIMAL` (where full PeerDB CDC can't run) since tombstones only need the PK/UNIQUE dedup key. The blind spot remains only when the source has no binlog at all, when the user lacks replication grants, or for tables with no PK/UNIQUE key.

## Docs

- [`CLAUDE.md`](CLAUDE.md) — orientation for Claude Code or anyone new to the codebase
- [`docs/replication-strategy.md`](docs/replication-strategy.md) — full three-phase design, open questions, implementation plan
- [`docs/peerdb-rustfs-migration-plan.md`](docs/peerdb-rustfs-migration-plan.md) — history of how we got here
- [`docs/peerdb-upstream-zero-date-patch.md`](docs/peerdb-upstream-zero-date-patch.md) — the zero-date workaround

## Contributing

Fork the repo, make a branch, open a PR. Add tests for new functionality.

## License

MIT. See LICENSE file.
