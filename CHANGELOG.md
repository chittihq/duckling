# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, with the latest unreleased work listed first.

## [0.5.3] - 2026-07-31

### Added

- **`DUCKLING_STORAGE_ROOT` — put the stack's data on an attached volume.** Named volumes live on the host's boot disk, so an attached block volume (DigitalOcean/Hetzner Volumes, EBS) goes unused unless the compose says otherwise — and the volume that grows is `clickhouse-data`, which belongs to the ClickHouse container, so no duckling-side setting can relocate it. `docker-compose.yml` now ships a documented, ready-to-uncomment volumes block binding all four volumes under `${DUCKLING_STORAGE_ROOT}`. Uncomment it once in the compose you deploy from and the path itself comes from the environment, so platforms that re-clone the repo on every deploy (Dokploy) stop overwriting it. Default behaviour is unchanged — plain named volumes, zero configuration. `docs/DEPLOYMENT.md` covers host preparation, the `uid 10001` ownership RustFS needs, migrating existing volumes, and verification.
- **Startup storage report.** The server now prints where data actually lands: its own data directory plus, queried from ClickHouse's `system.disks`, every disk with its path and free/total space. Capacity that reads as the boot disk's is the signal that an intended mount did not take effect. Degrades to a note when ClickHouse isn't up yet and never blocks boot.

### Changed

- **Release builds are ~3× faster** (10m46s → ~3m25s). The publish workflow built both architectures on one amd64 runner, so the arm64 image — `pnpm install`, three TypeScript builds, the Nuxt build — ran entirely under QEMU emulation, sequentially with amd64; that was 608 of 646 seconds on the v0.5.2 release. Each architecture now builds on a runner of its own architecture in parallel and a merge job assembles the multi-arch manifest. Also adds per-platform build cache scopes (the two platforms previously evicted each other's layers), `latest=auto` so a prerelease tag can't move `latest`, and a verification step that fails the release if an architecture is missing from the published manifest.

### Fixed

- Live CDC-lite test provisioning raced MySQL's startup: readiness was checked with `mysqladmin ping`, which answers during the image's init phase before the entrypoint restarts the server, so setup could fail mid-statement. Readiness is now a real query against the final server, with idempotent and retried user creation.

## [0.5.2] - 2026-07-31

Follow-up hardening to [0.5.1]. If you have not upgraded past 0.5.0 yet, read the 0.5.1 notes first — that release fixes an unauthenticated-access bug affecting all earlier versions.

### Security

- **Generated credentials are no longer printed to logs.** The first-boot banner echoed `ADMIN_PASSWORD` and `DUCKLING_API_KEY` in plaintext to stdout, where container logs are retained by the platform, streamed into deploy UIs, and shipped to log aggregators. It now names which secrets were generated and where to read them (`0600` `.secrets.json` on the data volume), never the values.
- **CORS is no longer permissive in production.** `cors({ origin: true, credentials: true })` reflected any `Origin` while allowing credentials, so any website could make authenticated cross-origin calls with a visitor's session cookie. Now: a `CORS_ORIGINS` allowlist when set, same-origin only in production when unset (the deploy serves dashboard and API on one origin), reflection retained outside production for the dev stack.
- **27 of 31 dependency advisories patched** via pnpm overrides — notably `jws` (the HMAC-verification path inside `jsonwebtoken`, i.e. JWT session auth), the Express 4 request chain (`path-to-regexp`, `qs`, `body-parser`), `fast-xml-parser` (AWS S3 responses), `@opentelemetry/core`, and `defu`. The 4 remaining are not actionable: one is a false positive (`brace-expansion@2.1.4` already carries the 2.x fix; the advisory's `<=5.0.7` range spuriously matches all 2.x), one needs a major bump of a transitive dep for an unreachable code path (`uuid` via `node-cron`), and two are build-only (`esbuild`, `diff`).
- Removed `packages/sdk/pnpm-lock.yaml` and `packages/sdk/examples/lib-example/pnpm-lock.yaml` (untouched since Oct 2025). Workspace members resolve through the root lockfile, so these were never read by the installer — they only pinned, and drew security alerts for, versions nobody installs.

## [0.5.1] - 2026-07-31

**Security release — upgrade immediately.** The case-variant path bypass below allows unauthenticated reads of database configuration (including MySQL connection strings) and arbitrary SQL execution on any instance reachable by an untrusted network. It affects all prior releases, not only 0.5.0.

### Added

- **CodeMirror 6 SQL editor in the dashboard** (#74). The query editor's plain `<textarea>` is replaced with a CodeMirror 6 component: SQL syntax highlighting, line numbers, bracket matching/auto-close, undo history, and autocompletion — SQL keywords plus live table names fetched from `/api/tables` (refreshed on database switch). Cmd/Ctrl+Enter still runs the query. Styled with the app's design tokens, so it follows the shadcn theme (including `.dark` if a theme toggle ever lands).
- **Single-port mode: MySQL wire protocol and HTTP can share one port** (#64). Opt-in via `MYSQL_PROTOCOL_SHARED_PORT=true`: a TCP multiplexer on the HTTP port classifies connections by first bytes — HTTP/WebSocket clients send first, MySQL clients silently await the server greeting (`MYSQL_PROTOCOL_DETECTION_TIMEOUT_MS`, default 50 ms). Dashboard, API, WebSocket, and MySQL clients all use one published port; default behavior (separate 3000 + 3307) is unchanged. MySQL remains raw TCP, so it's reachable via direct `IP:port`, not through HTTP reverse-proxy domains.

### Security

- **Critical: unauthenticated access via case-variant API paths.** Express matches routes case-insensitively, but the auth gate, the per-database scope guard, and the rate-limit classifier all compared paths case-sensitively — so `GET /API/DATABASES` returned the full database config list (including connection strings) with no credentials, `POST /API/QUERY` executed arbitrary ClickHouse SQL, and `/API/DATABASES/:id/api-keys` exposed key metadata, all while bypassing rate limiting entirely. Verified against a running server before and after. All security decisions now run on a normalized path (`utils/routePath.ts`) that matches Express's own routing semantics.
- **Login brute-force budget bypassed by a trailing slash.** `POST /api/login/` routes to the login handler but failed the classifier's exact match, so it fell outside the auth budget and allowed unlimited password attempts (confirmed: 12/12 accepted vs. 429 after 10 on the canonical path). Fixed by the same normalization.
- **`TRUST_PROXY` default hardened.** The previous `1` trusted one hop unconditionally, which — with port 3000 published — let a direct client forge `X-Forwarded-For` to evade per-IP limits or poison another client's bucket. The compose now defaults to `uniquelocal`: forwarded IPs are trusted only from private-network peers (a proxy on the Docker network), never from a direct public client.
- **Invalid-token attempts no longer lock out password login.** Failed-credential charging shared one per-IP bucket with `/api/login`, so an expired dashboard token retrying in the background could exhaust it and 429 a legitimate login from the same office/NAT IP before the password was checked. Invalid tokens now use a separate bucket (verified: login still succeeds after a token flood exhausts the token budget).
- **Unauthenticated requests are now metered.** Credential-free `read`/`query`/`write` requests terminated in the auth middleware before the post-auth limiter, leaving body parsing and logging entirely unmetered; they are now charged to the anonymous per-IP bucket at their own category (so they can't drain the login budget). An empty `?token=` no longer counts as "credentials presented".
- **Bucket-scope spoofing via `X-Database-Id`.** The limiter keyed on a header that plays no part in selecting the database, letting an authenticated caller mint a fresh bucket per request while hitting the same database. Scope now derives only from `?db` and the request's own path/scoped key.
- **Concurrent SSE streams are now capped per identity** (`RATE_LIMIT_*_STREAM_MAX`). Each `/sync/events` connection was charged once as a read but then held a socket, heartbeat timer, and listener indefinitely, so live resources grew unbounded under the request rate.
- **Query-concurrency slots no longer leak on long queries.** A query outliving `staleEntryTtlMs` had its slot evicted; its later release then decremented a *different* query's slot, admitting extra concurrent queries. Slots now carry a generation tag.
- Paths ending in `/diagnose/stream` no longer claim monitoring rates from an unanchored suffix match; the pattern is anchored to the real route.
- Dependency updates (supersedes Dependabot PRs #86/#87/#95): `nuxt` 4.4.2 → 4.4.8 (includes the 4.4.7 security hotfix), `ws` 8.19 → 8.21, `postcss` → 8.5.18, `vitest` → 3.2.6, plus transitive bumps (`devalue`, `lodash`, `nitropack`, `node-forge`, `picomatch`, `serialize-javascript`, `@babel/core`, `launch-editor`). `rollup` is pinned to 4.59.1 via a pnpm override: rollup ≥ 4.60 misclassifies Nuxt's `#build/*` virtual modules as source-phase imports and fails the frontend build (bisected; remove the override once Nuxt/Vite ship a compatible resolution).

### Fixed

- **Rate limiting redesigned around real client identity.** Three compounding flaws made 429s appear under normal dashboard use, especially behind a reverse proxy:
  - `/api/check-auth` (called by the dashboard on every navigation) and `/api/logout` shared the strict 10/min login brute-force budget. They are now classified as monitoring; only `/api/login` draws from the auth budget.
  - Auth/monitoring endpoints were only ever limited pre-auth on the anonymous per-IP bucket, so a logged-in dashboard got the smallest budget in the system. Monitoring requests presenting credentials now defer to the post-auth limiter, which keys on the authenticated identity with the tier multiplier. Presented-but-rejected tokens are charged to the per-IP brute-force budget instead (invalid-credential hammering can no longer hide behind free 401s).
  - The deploy compose never set `TRUST_PROXY`, so behind Traefik/Dokploy every client collapsed into one shared per-IP bucket (the proxy's). The compose now defaults `TRUST_PROXY=1` (set `0` when exposing port 3000 directly), and the server logs a one-time warning when rate limiting sees `X-Forwarded-For` while `TRUST_PROXY` is unset.

### Changed

- Deploy compose now pins `chittihq/duckling` to the exact release tag (overridable via `DUCKLING_IMAGE`) instead of `:latest`, so redeploys are deterministic — `docker compose up` reuses a cached `:latest` and silently skips new releases. Release procedure: bump the pin in `docker-compose.yml` alongside the version bump.

## [0.5.0] - 2026-07-30

### Added

- **CDC-lite**: a lightweight binlog tailer (`BinlogTailerService`, built on `@vlasky/zongji`) that augments polling mode. DELETE row events become tombstone rows that the projection view resolves at read time — closing the count-neutral delete+insert blind spot — and INSERT/UPDATE events trigger immediate per-table incremental syncs. **No flag — purely capability-driven per database**: full CDC capability → `peerdb`; ROW binlogs + `REPLICATION SLAVE`/`CLIENT` grants (even with `binlog_row_metadata=MINIMAL`, the managed-MySQL default that blocks full PeerDB CDC) → polling + CDC-lite; otherwise pure polling. Best-effort: any failure degrades to exactly the previous pure-polling behavior. DDL (`ALTER`/`RENAME`/`TRUNCATE`/`DROP`) invalidates cached dedup keys, so tombstones follow primary-key changes. Checkpoints prefer GTID sets (survive binlog rotation and failover) with file+position fallback. Tested three ways: unit suite, a live Docker-provisioned spec-exact MySQL exercising the full operation matrix (insert/update/delete/multi-delete/composite-PK/ALTER/PK-change/temp-tables/views/rollback/TRUNCATE) over a real binlog stream, and integration suite 17 covering the blind-spot case end-to-end under MINIMAL metadata.

### Fixed

- **Projection views are now tombstone-aware**: the dedup window runs over all row versions first and the delete-filter applies to the winner (previously `_sync_deleted` was filtered before dedup, so a tombstone could never shadow the live row it was deleting). No-op for existing data; views are refreshed in place when CDC-lite starts.

## [0.4.0] - 2026-07-30

### Added

- Connection diagnosis now shows the **full binlog-CDC capability checklist**: `binlog_row_metadata` (the usual managed-MySQL blocker — e.g. DigitalOcean defaults to `MINIMAL`), GTID mode, `REPLICATION SLAVE`/`CLIENT` grants, binlog retention, and a bottom-line CDC-readiness verdict. Checks are derived from the same capability probe the replication coordinator uses to pick the mode, so the dashboard can never disagree with the mode actually selected. Hard CDC requirements show ✗ when unmet or unreadable; advisories (GTID, retention) warn.
- `CLICKHOUSE_FINAL_READS` (default `true`) — see the fix below.

### Changed

- **Compose files swapped**: `docker-compose.yml` is now the self-host deploy stack (published image + ClickHouse; formerly `docker-compose.prod.yml`), so `docker compose up -d` deploys out of the box. The dev stack (source builds + hot reload) moved to `docker-compose.dev.yml` — use `docker compose -f docker-compose.dev.yml up -d` for development.
- **PeerDB is now the primary replication mode in the default deploy** — the deploy compose bundles the full PeerDB CDC stack (catalog Postgres, Temporal, flow services, RustFS) always-on with `REPLICATION_BACKEND=peerdb`; polling remains the automatic fallback for sources without binlog CDC. The flow services are pinned to `chittihq/peerdb-flow-*:v0.36.19-zerodate-v3` — zero-date-patched builds published to Docker Hub by the new `publish-peerdb-patched.yml` workflow (pinned upstream commit + the v3 patch), so peerdb mode is zero-date-safe on a fresh server without a local source build. Debug UIs (PeerDB UI, Temporal UI) sit behind `--profile debug`; only duckling publishes host ports.

### Fixed

- **peerdb-mode reads could return duplicate rows / over-counts between background merges.** PeerDB destination tables are `ReplacingMergeTree`, whose dedup is eventual (merge-time), and no query surface applied `FINAL` — so `/api/query`, the WebSocket SDK, the MySQL wire protocol, and the table data/count/validation endpoints could all transiently over-count, non-deterministically. All reads now apply the ClickHouse `final = 1` query setting at the single shared client wrapper (no-op on the polling-mode plain-MergeTree layout; requires ClickHouse ≥ 23.2; opt out with `CLICKHOUSE_FINAL_READS=false`). Also fixes stale reads of the internal `appender_watermarks` / `full_sync_sessions` / `cdc_binlog_position` state tables.

### Documentation

- README: clarified mode ownership — `peerdb` is PeerDB end-to-end (snapshot + binlog streaming as one continuous operation; duckling never touches the data), `polling` is **not CDC**; documented the polling-mode delete blind spot (a count-neutral delete+insert survives until the next full rebuild).

## [0.3.0] - 2026-07-08

First release on the **ClickHouse** runtime — the DuckDB era is fully retired — plus a turnkey self-host deployment. Covers ~75 commits since 0.2.0.

### Added

- **Three-phase replication with per-database modes**: duckling bootstrap (Phase 1) → PeerDB binlog CDC or 1-second polling (Phase 2), auto-selected by a source capability probe (`log_bin`, `binlog_format`, `binlog_row_image`, `binlog_row_metadata`, replication grants) and pinnable via `POST /api/databases/:id/replication-mode`.
- **PeerDB integration**: orchestrator + SQL client create source/target peers and per-table mirrors via the flow API; opt-in stack (`docker-compose.peerdb.yml` — catalog Postgres, Temporal, flow workers, RustFS) brought up by `scripts/peerdb-up.sh`.
- **Per-database API keys** (`dk_…`): minted from the dashboard (`/api-keys`) or `POST /api/databases/:id/api-keys`, scoped to a single database's data plane (403 on other databases and the entire control plane), stored hash-only, resolved via an in-memory index — no per-request disk I/O. Full e2e suite.
- **Turnkey self-host deploy**: `docker-compose.prod.yml` with the published `chittihq/duckling` image + bundled ClickHouse + named volumes. Zero required environment variables — admin password, API key, and session secret auto-generate on first boot (persisted to `<data>/.secrets.json`, printed once in logs); databases are added from the dashboard (`MYSQL_CONNECTION_STRING` is optional and no longer creates a phantom default database).
- **S3 backups on ClickHouse-native `BACKUP`/`RESTORE`**: scheduled or manual, restore-as-side-database, and a path-prefix guard on restore/delete keys (accident guard, not a tenant security boundary).
- **Unique-key dedup fallback**: tables without a primary key now dedup on a UNIQUE index instead of accumulating duplicates on every incremental re-sync (`suite16` integration coverage).
- `TRUST_PROXY` / `TRUST_PROXY_HOPS` for correct client IPs (rate limiting + WebSocket) behind reverse proxies.
- Multi-arch image publishing (linux/amd64 + linux/arm64) on release tags.

### Changed

- **Runtime migrated from DuckDB to ClickHouse.** Storage layout per table: `<table>__raw` append-only MergeTree + `<table>` projection view (`row_number()` per dedup key, newest `_sync_timestamp` wins). All parameterized queries route through native `query_params`.
- Root `Dockerfile` rebuilt for the ClickHouse runtime: single container serves API + dashboard same-origin (ClickHouse itself is a separate service — see the compose files).
- Integration harness runs against ClickHouse exclusively (16 suites), with the PeerDB stack exercised end-to-end by default.

### Fixed

- **PeerDB zero-date corruption**: stock PeerDB v0.36 silently turns MySQL `0000-00-00` into `1970-01-01` on the ClickHouse path. A row-read-layer patch (`PEERDB_MYSQL_ZERO_DATE_AS_NULL`) converts zero/partial-zero dates to `NULL` in both snapshot and CDC, matching polling-mode behavior. `scripts/peerdb-up.sh` builds SHA-pinned patched flow images so peerdb mode is zero-date-safe by default (patch not yet upstreamed; `1000-01-01` Date32 clamp still open).
- Database deletion now stops the polling CDC service and automation loops and closes the MySQL pool (was leaking pollers, timers, and connections) (#70).
- Constant-time comparison for API key checks (#71).
- Rate limiting keyed on the real client IP behind proxies (#66).
- Table views build result columns from all rows instead of just the first (#75).

## [0.2.0] - 2026-04-02

### Added

- Docker image publishing workflow for release tags via `.github/workflows/docker-publish.yml`.
- Resumable full sync for primary-key-backed tables.
  - Full sync progress is now tracked in the internal `full_sync_sessions` DuckDB table.
  - Interrupted full syncs resume from the last flushed primary-key cursor instead of restarting from row 1.
  - `swapping` sessions resume the final cutover without rereading MySQL.
  - New config flag: `FULL_SYNC_RESUME_ENABLED` (enabled by default).
- DuckDB runtime settings (`memory_limit`, `threads`, `temp_directory`, `max_temp_directory_size`, `preserve_insertion_order`) are now configurable via environment variables and applied at startup.
- Dedicated `runTransaction()` method on `DuckDBConnection` that runs multi-statement transactions on an isolated connection with automatic retry on write-write conflicts.
- WAL auto-checkpoint is now suppressed (`wal_autocheckpoint='1TB'`) during sync windows to prevent background checkpoint writes from conflicting with merge transactions. Restored to `10MB` after sync completes.
- MySQL `ER_OUT_OF_SORTMEMORY` errors during incremental sync are now automatically retried with a 10x smaller batch size (minimum 100 rows).
- Sentry integration (`SENTRY_DSN`) for error tracking with Express request context.
- SDK: `reconnectExhausted` event emitted when auto-reconnect gives up after the configured attempts.
- SDK: configurable `requestTimeout` (default 30s) for per-request timeouts.

### Changed

- **Incremental merge strategy**: replaced the multi-statement `BEGIN` / `DELETE` / `INSERT` / `COMMIT` staging merge with a single `INSERT OR REPLACE INTO target SELECT * FROM staging`. This eliminates write-write conflicts caused by DuckDB's non-transactional index handling (DuckDB issues [#17802](https://github.com/duckdb/duckdb/issues/17802), [#20053](https://github.com/duckdb/duckdb/issues/20053)).
- Full sync staging swap and sequential INSERT fallback now use `runTransaction()` with dedicated connections to prevent governor interleaving.
- Merge SQL (`buildAlignedInsertSql`) is now pre-computed before appender work starts, avoiding persistent-connection reads in the critical window between appender-close and merge-COMMIT.
- Parameter binding logic extracted into shared `bindParams()` method used by both `runRaw()` and `runTransaction()`.
- Internal DuckDB maintenance work now bypasses normal query-governor timeouts.
- Frontend upgraded to Nuxt `4.4.2`.
- Startup log updated from outdated "Parquet Server" to "Duckling Server".
- SDK: `connect()` resets the reconnect budget; internal reconnect timer uses `_doConnect()` which preserves the budget across retries.
- SDK: exponential backoff for reconnection (was linear).
- SDK: `close()` uses `manualClose` flag instead of mutating `config.autoReconnect`.
- SDK: all errors now use typed `DuckDBError` with `DuckDBErrorType` categorization.

### Fixed

- Full sync and incremental staging merges now align insert columns by name instead of relying on positional `SELECT *` swaps.
- Sync log count query with filters now passes the correct parameters (was missing filter params on the COUNT query).
- CDC backpressure: fixed unbounded event queue growth with TCP socket fallback and critical queue limit.
- Database config writes are now atomic with corrupted config preservation.
- SDK: `reportError()` checks `listenerCount('error')` before emitting to prevent Node.js crashes on unhandled error events.
- SDK: `handleMessage` handles all `WebSocket.RawData` variants (string, Buffer, Buffer[], ArrayBuffer).

## [0.1.0] - 2026-03-22

Initial tagged release.

### Included

- MySQL to DuckDB replication with full sync, watermark-based incremental sync, and optional CDC.
- Query access over REST, WebSocket, and the MySQL wire protocol.
- Nuxt frontend dashboard.
- Backup, sync automation, and Docker-based deployment support.
