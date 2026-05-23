# Replication strategy

This document describes how duckling replicates MySQL → ClickHouse. The strategy is **three-phase**: an initial dump+ingest that we own, followed by either PeerDB CDC (when the MySQL source supports binlog CDC) or in-repo polling (when it doesn't).

## TL;DR

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1 — BOOTSTRAP (always)                                    │
│   Duckling dumps MySQL → ingests into ClickHouse                │
│   Records binlog position at the start of the dump              │
│   Owner: duckling (DumpService)                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Capability probe — can the MySQL source do binlog CDC?          │
│   log_bin = ON                                                  │
│   binlog_format = ROW                                           │
│   binlog_row_image = FULL                                       │
│   binlog_row_metadata = FULL                                    │
│   user has REPLICATION SLAVE + REPLICATION CLIENT               │
└─────────────────────────────────────────────────────────────────┘
                  │                              │
            CDC capable                    CDC not capable
                  │                              │
                  ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Phase 2A — PeerDB CDC        │   │ Phase 2B — Polling fallback  │
│   doInitialSnapshot: false   │   │   CdcCompatibilityService    │
│   resume from binlog pos     │   │   1s row-count + change      │
│   recorded in Phase 1        │   │     token poll               │
│   Owner: PeerDB              │   │   Owner: duckling            │
└──────────────────────────────┘   └──────────────────────────────┘
```

## Why three phases (not just "use PeerDB end-to-end")

PeerDB's mirror creation already includes an initial snapshot, so in principle it could do everything. We choose to own the dump for these reasons:

1. **Decoupling.** Dump+ingest must work even if PeerDB isn't deployed — e.g. on a customer's air-gapped environment, on the first day before PeerDB is brought up, or when PeerDB is intentionally disabled.
2. **CDC fallback.** Many MySQL sources (managed databases without binlog access, read-replicas with row image MINIMAL, sources where the user can't grant REPLICATION SLAVE) can't be replicated by PeerDB at all. For those, we still need a working bootstrap.
3. **Operational visibility.** We control retries, batching, and per-table progress reporting during the bootstrap. Sync logs, watermarks, and dashboards all keep working uniformly.
4. **Clean replacement story.** PeerDB is one option for Phase 2; if it gets replaced (different CDC tool, different MQ), the bootstrap path doesn't change.

## Backend ownership of Phase 1

| `replicationMode` | Phase-1 owner | Destination schema | Phase-2 owner | Why                                                                                                                                                                              |
|-------------------|---------------|--------------------|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `peerdb`          | **PeerDB**    | PeerDB-created tables (engine-specific, includes `_peerdb_*` metadata columns) | PeerDB        | PeerDB v0.36 strictly validates destination tables — attempts to pre-populate with the full `_peerdb_*` column set still failed validation. Until upstream supports attach-to-existing-table or per-mirror start position, we let PeerDB own the load. We still record the source binlog position via the capability probe for diagnostics.   |
| `polling`         | **duckling**  | `<table>__raw` MergeTree + `<table>` projection view (existing layout) | duckling polling | Optimized for repeated full + watermark-based incremental syncs.                                                              |
| `none`            | **duckling**  | Same as `polling`                                                       | (none)        | Bootstrap-only deploys. Useful for one-shot copies and verification runs.                                                                                          |

In `polling` and `none` modes, duckling captures the source binlog position before any read so a future switchover to PeerDB has the position recorded. In `peerdb` mode the coordinator captures the position as informational — PeerDB tracks its own internal progress in its catalog regardless.

## Phase 1 — Bootstrap (DumpService) — polling / none modes

**Owner:** duckling. New service: `packages/server/src/services/dumpService.ts`.

**Algorithm:**

1. Open a long-running MySQL connection.
2. `SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ`.
3. `START TRANSACTION WITH CONSISTENT SNAPSHOT` — this gives a snapshot at a single binlog position for all subsequent reads in the transaction.
4. `SHOW MASTER STATUS` (or `SELECT @@gtid_executed` when GTID is on) — record `(file, position)` and/or GTID set. Persist into `databases.json` under `bootstrap.binlogPosition`.
5. For each MySQL table in parallel (concurrency = `BOOTSTRAP_PARALLEL_TABLES`, default 4):
   - Stream via keyset pagination, batches of `FULL_SYNC_BATCH_SIZE` (default 1000).
   - Write into `<clickhouseDatabase>.<table>__raw` (MergeTree).
   - Per-table progress recorded in `databases.json` under `bootstrap.tableProgress[<table>]`.
6. After all tables complete, build/refresh the projection views (`<table>` over `<table>__raw`).
7. `COMMIT` the MySQL transaction.
8. Mark `bootstrap.status = 'completed'`, set `bootstrap.completedAt`.

**Failure handling:**

- On error in any table: `bootstrap.status = 'failed'`, error message persisted. Operator triggers `/api/databases/:id/bootstrap?resume=true` to retry.
- Resume reuses the recorded `binlogPosition` (still consistent — MySQL retains binlogs for the retention period) and skips tables already marked `completed`.

**Why a transaction with a consistent snapshot:** InnoDB's MVCC means the dump reads see the same committed state across all tables, even if writers are active. Without this, an `events` row inserted after we'd already dumped its table could be missed during bootstrap and then double-counted by CDC.

## Phase 2A — PeerDB CDC (when capable)

**Owner:** PeerDB, wired by `peerdbOrchestratorService.ts`.

**Snapshot ownership (current reality):**

PeerDB performs BOTH the initial snapshot and the CDC stream via
`doInitialSnapshot: true`. The coordinator (`replicationCoordinator.ts`'s
`mode === 'peerdb'` branch in `startPhase2`) drops any polling-path
artifacts (`<table>` view, `<table>__raw` raw table) for each MySQL table
before calling `createMirror`. PeerDB then creates its own destination
tables with the layout its connector expects.

**Why duckling doesn't own Phase 1 in peerdb mode:** the
`BootstrapService.bootstrapTableForPeerDB` path (which produces a
`ReplacingMergeTree(_peerdb_synced_at)` table with the full `_peerdb_*`
metadata column set: `_peerdb_uid`, `_peerdb_timestamp`,
`_peerdb_record_type`, `_peerdb_is_deleted`, `_peerdb_synced_at`) exists in
the code and remains callable. We tested it against PeerDB v0.36 across
several column variants; PeerDB's ClickHouse destination validator still
rejects pre-populated tables with `"not all PeerDB columns found in
destination table"`. The duckling-dump → PeerDB-CDC handoff is therefore
**not shipped** today. Two upstream changes would unblock it:

1. PeerDB destination validator gains an "attach to existing destination"
   flag and trusts the schema duckling produced.
2. PeerDB exposes per-mirror `cdcStartingFromGtid` / `cdcStartingPosition`
   so duckling-recorded binlog positions are honored when
   `doInitialSnapshot: false`.

Both are documented as future work in this doc; neither is in this branch.

**Binlog-position handoff (current reality):** the orchestrator's
`createMirror` still accepts `{ doInitialSnapshot: false, startPosition }`
and sets env vars (`PEERDB_MYSQL_START_GTID` /
`PEERDB_MYSQL_START_BINLOG_FILE` / `PEERDB_MYSQL_START_BINLOG_POSITION`).
Upstream PeerDB does NOT honor those env names. The coordinator does not
take this path for peerdb mode today — it's plumbing for the upstream-fix
future. The capability probe DOES capture the binlog position for
diagnostic purposes (visible via `/api/databases/:id/bootstrap/status`).

## Phase 2B — Polling fallback (when CDC unavailable)

**Owner:** duckling. Existing service: `cdcCompatibilityService.ts`, with one adjustment.

**Current behavior:** on first cycle, snapshots are empty so the service used to do a full `runSync()`. After the bootstrap change, snapshots are pre-populated from the dump (the service reads existing `appender_watermarks` rows on startup) and the first cycle just establishes change tokens.

**Detection:** if the capability probe says CDC isn't supported, the replication coordinator starts `CdcCompatibilityService` instead of calling the PeerDB orchestrator. Same `/cdc/start` and `/cdc/stop` API; backend chosen automatically.

## Capability probe

**Where:** `packages/server/src/services/replicationModeDetector.ts` (new), called by the replication coordinator after Phase 1 completes (or on `/cdc/start` for an existing database).

**Checks against the source MySQL:**

```sql
SHOW VARIABLES LIKE 'log_bin';                -- must be 'ON'
SHOW VARIABLES LIKE 'binlog_format';          -- must be 'ROW'
SHOW VARIABLES LIKE 'binlog_row_image';       -- must be 'FULL'
SHOW VARIABLES LIKE 'binlog_row_metadata';    -- must be 'FULL' for PeerDB
SHOW GRANTS FOR CURRENT_USER();               -- must include REPLICATION SLAVE + CLIENT
```

If all pass and `peerdb.enabled` is true on the database config, mode = `peerdb`. Otherwise mode = `polling`. The detected mode is persisted under `dbConfig.replicationMode` so it survives restarts and can be inspected via `/api/databases/:id`.

**Override:** the operator can pin a mode by setting `dbConfig.replicationMode` to `peerdb`, `polling`, or `none` (no continuous replication; bootstrap only).

## State machine in `databases.json`

```ts
interface DatabaseConfig {
  id: string;
  name: string;
  mysqlConnectionString: string;
  clickhouseDatabase: string;
  bootstrap: {
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
    binlogPosition?: {
      mode: 'gtid' | 'filepos';
      gtid?: string;
      file?: string;
      position?: number;
    };
    tableProgress: Record<string, {
      status: 'pending' | 'in_progress' | 'completed' | 'failed';
      recordsProcessed: number;
      lastProcessedId?: string | number;
      error?: string;
    }>;
    error?: string;
  };
  replicationMode?: 'peerdb' | 'polling' | 'none';
  peerdb?: { ... existing fields ... };
  createdAt: string;
  updatedAt: string;
}
```

Existing databases (created before this change) are migrated on first load: `bootstrap.status` is set to `'completed'` with no binlog position. They keep using the legacy in-repo polling path; if the operator wants CDC, they call `/api/databases/:id/bootstrap?force=true` to redo the dump and capture a fresh binlog position.

## API surface

### New endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/databases/:id/bootstrap` | Trigger Phase 1. Body: `{ force?: boolean, resume?: boolean }` |
| `GET` | `/api/databases/:id/bootstrap/status` | Per-table progress |
| `GET` | `/api/databases/:id/replication-mode` | Auto-detected mode + capability probe results |

### Changed endpoints

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/api/databases` | New databases are auto-bootstrapped on creation if `autoBootstrap !== false` in the request body |
| `POST` | `/cdc/start` | Starts whichever Phase 2 (PeerDB or polling) corresponds to `dbConfig.replicationMode` |
| `POST` | `/sync/full` | When `dbConfig.bootstrap.status === 'pending'`, treated as bootstrap; otherwise refreshes the projection view and re-runs the dump |

### Deprecated

- The current `/sync/full` semantics (always full re-dump) become `?force=true`. Default behavior becomes idempotent.

## Migration path

1. **First server boot after this change**:
   - For every existing database in `databases.json`, inject `bootstrap.status = 'completed'`, `replicationMode = 'polling'` (current default). No data movement.
2. **New databases (default)**:
   - Created with `bootstrap.status = 'pending'`. The first `/sync/full` call (or auto-bootstrap on add) runs Phase 1.
3. **Switching an existing database to PeerDB CDC**:
   - `POST /api/databases/:id/bootstrap?force=true` — re-dumps, captures binlog position.
   - `POST /api/databases/:id/replication-mode` with `{ mode: 'peerdb' }` (or `auto`).
   - `POST /cdc/start?db=:id` — orchestrator creates the source/target peers + mirrors with `doInitialSnapshot: false`.

## Implementation status

What landed (this branch):

### Phase A — BootstrapService ✅ shipped

- `packages/server/src/services/bootstrapService.ts` — owns Phase 1 for polling/none modes.
- Captures source binlog position via `mysql.captureBinlogPosition()` (GTID preferred, falls back to `SHOW [BINARY LOG \| MASTER] STATUS`) before any read.
- Iterates tables via `syncService.forceFullSyncTable` (polling layout) or `syncService.bootstrapTableForPeerDB` (PeerDB layout; **not used by coordinator today** — see Phase C).
- Persists per-table progress + final state to `databases.json` atomically.
- Supports `force` and `resume` options. Concurrent callers join the in-flight run instead of erroring.

**Not done:** consistent-snapshot transaction wrapping (per-table reads are independent today; cross-table snapshot may be slightly inconsistent under writes — open question #1).

### Phase B — Capability probe + coordinator ✅ shipped

- `packages/server/src/services/replicationModeDetector.ts` — probes `log_bin`, `binlog_format`, `binlog_row_image`, `binlog_row_metadata`, `gtid_mode`, plus `SHOW GRANTS` for `REPLICATION SLAVE`/`REPLICATION CLIENT`. Returns `{ recommendedMode, cdcSupported, reasons, variables, grants, knownBlockers }`.
- `packages/server/src/services/replicationCoordinator.ts` — `runBootstrap`, `detectMode`, `bootstrapAndStart`, `stopPhase2`. Single orchestration point for HTTP handlers.
- API: `GET /api/databases/:id/replication-mode` returns the probe result plus pinned vs effective mode.

### Phase C — PeerDB handoff ⚠️ partial (plumbed, not wired into the live path)

- `PeerDBOrchestratorService.createMirror` accepts `{ doInitialSnapshot, startPosition }` and sets env vars (`PEERDB_MYSQL_START_GTID` / `PEERDB_MYSQL_START_BINLOG_FILE` / `PEERDB_MYSQL_START_BINLOG_POSITION`).
- `ClickHouseSyncService.bootstrapTableForPeerDB` creates the PeerDB-compatible `ReplacingMergeTree(_peerdb_synced_at)` table with the full `_peerdb_*` metadata column set and dumps into it.

**Why these are dormant:** PeerDB v0.36's destination connector rejects pre-populated tables with `"not all PeerDB columns found"` regardless of which metadata-column variant we try, and PeerDB upstream doesn't honor the `PEERDB_MYSQL_START_*` env vars. The coordinator therefore uses `doInitialSnapshot: true` and lets PeerDB own the load for peerdb mode (see `replicationCoordinator.ts:212` — the `mode === 'peerdb'` branch). The plumbing remains so the day PeerDB upstream supports either flag, the coordinator change is one line.

### Phase D — Polling reconciliation ✅ shipped

- `CdcCompatibilityService`'s first cycle already skips re-snapshotting tables that exist in ClickHouse (which they all do after bootstrap). Verified in suite 6 of the integration suite.

### Phase E — Migration + API ✅ shipped

- `DatabaseConfigManager.applyMigrations` backfills `bootstrap.status='completed'` and `replicationMode='polling'` for legacy database entries on load.
- New databases default to `bootstrap.status='pending'`; `POST /api/databases` auto-bootstraps in the background unless `autoBootstrap: false`.
- Routes: `POST /api/databases/:id/bootstrap`, `GET /api/databases/:id/bootstrap/status`, `GET|POST /api/databases/:id/replication-mode`.
- Frontend: `/replication` page with bootstrap status, capability probe results, mode picker, Phase-2 start/stop, and `knownBlockers` display.

### Phase F — Docs + tests ✅ shipped (this commit included)

- `CLAUDE.md` and `README.md` rewritten to reflect the actual architecture (no more DuckDB / S3 backup claims; honest about PeerDB ownership of Phase 1 in peerdb mode).
- Integration suite — `zsuite-peerdb-flow.test.ts` exercises capability probe + bootstrap + Phase 2 start through the coordinator end-to-end. 16/16 test files pass.

### Phase G — Open work (NOT in this branch)

- Resume-from-binlog-position handoff: requires upstream PeerDB change (attach-to-existing OR per-mirror start position).
- PeerDB zero-date corruption: requires upstream patch (POC in `docs/peerdb-upstream-zero-date-poc-v2.patch`).
- Consistent-snapshot transaction wrapping for polling-mode bootstrap.
- Shadow-table swap for non-disruptive re-bootstrap.
- Schema-drift detection during dump.
- GTID expiry warning in capability probe (`binlog_expire_logs_seconds`).

## Open questions

1. **Mid-dump writes.** During Phase 1, MySQL is still accepting writes. The `START TRANSACTION WITH CONSISTENT SNAPSHOT` gives us a fixed snapshot, and PeerDB picks up everything after the recorded binlog position. But if Phase 1 is very long (e.g. 200 GB on a busy database), the binlog accumulates a lot of catch-up events. PeerDB will replay them all when CDC starts — fine in theory, but expect a delay before "live" status. Document this expectation; possibly emit a metric.
2. **Schema drift mid-dump.** If a table is `ALTER`ed during Phase 1, the snapshot is invalidated for that table. MVCC will give us a consistent read of the original schema, but PeerDB's CDC will see the ALTER event. Strategy: detect schema changes via `information_schema.tables.update_time` polling during Phase 1 and abort with a clear error if any source schema changed.
3. **Re-bootstrap UX.** A re-bootstrap drops the existing ClickHouse tables and re-creates them, which interrupts queries. Mitigation: dump into shadow tables (`<table>__raw_new`), then atomic `RENAME TABLE` swap, then drop old. Add this as Phase G if/when needed.
4. **MySQL GTID gaps after restart.** If MySQL is restarted between Phase 1 dump and PeerDB taking over, GTIDs may have been purged. Capability probe should also surface `binlog_expire_logs_seconds` and warn if it's smaller than the expected dump duration.

## Component status snapshot

| Component | Status |
|-----------|--------|
| `ClickHouseSyncService.fullSync` (bulk dump on demand) | ✅ Used by `BootstrapService` for polling-layout dump |
| `ClickHouseSyncService.bootstrapTableForPeerDB` (PeerDB-layout dump) | ⚠️ Implemented; not invoked by coordinator (PeerDB rejects pre-populated tables in v0.36) |
| `PeerDBOrchestratorService.createMirror` | ✅ Creates source peer, target peer, per-table mirrors; accepts `doInitialSnapshot` + `startPosition` (latter dormant pending upstream) |
| `CdcCompatibilityService` (polling) | ✅ Works |
| `MySQLConnection.streamTableData` (keyset pagination) | ✅ Works |
| `MySQLConnection.captureBinlogPosition` | ✅ GTID-preferred, file+pos fallback |
| `MySQLConnection.getVariable` / `getCurrentUserGrants` | ✅ Used by capability probe (uses `query()` not `execute()` to dodge prepared-statement issues) |
| `appender_watermarks` + projection view in CH | ✅ Used by polling layout |
| `BootstrapService` | ✅ Polling mode owns load; PeerDB mode delegates to PeerDB |
| `replicationModeDetector` + capability probe | ✅ With `knownBlockers` surfacing the zero-date issue |
| `ReplicationCoordinator` | ✅ Bootstrap + Phase-2 selection + start/stop |
| `dbConfig.bootstrap` + `dbConfig.replicationMode` | ✅ On `DatabaseConfig`, with migration for legacy rows |
| Bootstrap-aware PeerDB handoff (`doInitialSnapshot: false` + position) | ❌ Blocked on upstream PeerDB — code is plumbed but unused |
| API: `/api/databases/:id/bootstrap`, `/bootstrap/status`, `/replication-mode` (GET+POST) | ✅ Wired |
| Auto-bootstrap on `POST /api/databases` | ✅ Fires in background unless `autoBootstrap: false` |
| `/cdc/start` and `/cdc/stop` routed through coordinator | ✅ Single orchestration path |
| Frontend `/replication` page with bootstrap + mode + blockers | ✅ Shipped (auth-protected via dashboard middleware) |
| PeerDB zero-date corruption | ❌ Active blocker; surfaced in `knownBlockers`. Workaround: use polling mode, OR build patched PeerDB via `scripts/build-peerdb-zero-date-poc.sh`, OR accept corruption. |
