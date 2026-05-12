# PeerDB + RustFS Migration Plan

## Goal

Replace Duckling's in-repo MySQL -> ClickHouse replication path with PeerDB, while keeping Duckling as the query, API, UI, and protocol layer on top of ClickHouse.

This plan assumes:

- MySQL remains the operational source of truth
- ClickHouse remains the analytical store
- PeerDB becomes the replication engine
- RustFS replaces MinIO as the S3-compatible staging layer

## Why this architecture

PeerDB is a better fit for real-time CDC than the current in-repo sync implementation. Duckling already works well as:

- ClickHouse query API
- WebSocket query service
- MySQL wire-protocol compatibility layer
- dashboard/auth/management UI

That split is cleaner than continuing to own CDC internals here.

## Target topology

```text
MySQL
  ↓
PeerDB flow-worker / snapshot-worker
  ↓              ↘
catalog Postgres  Temporal
  ↓
RustFS (S3-compatible staging)
  ↓
ClickHouse
  ↓
Duckling server / frontend / SDK / MySQL protocol
```

## Required PeerDB services

PeerDB self-hosting requires more than a single container. The minimum useful stack is:

- `peerdb-server`
- `flow-api`
- `flow-worker`
- `flow-snapshot-worker`
- catalog Postgres
- Temporal
- RustFS

Optional but practical:

- PeerDB UI
- Temporal UI

## RustFS role

PeerDB's ClickHouse path stages files in S3-compatible object storage before ClickHouse ingests them. RustFS can fill that role if:

- it is reachable by PeerDB services
- it is reachable by ClickHouse
- it supports the S3 operations PeerDB uses in practice
- path-style / auth / TLS settings are correct for both sides

## What changes inside Duckling

Duckling should stop acting as the replication engine.

### Keep

- ClickHouse query execution
- health/status endpoints
- MySQL protocol compatibility server
- frontend dashboard
- SDK
- database selector / auth / rate limiting / governance

### Replace

- `ClickHouseSyncService`
- `ClickHouseAutomationService`
- `CdcCompatibilityService`

### Rewire endpoints

Existing endpoints should stay stable where possible, but their implementation changes:

- `POST /sync/full`
  - create or resync PeerDB mirrors for the selected database
- `POST /sync/incremental`
  - ensure mirrors are active / resumed
- `POST /sync/table/:tableName`
  - table-scoped mirror resync or rematerialization
- `GET /sync/status`
  - return PeerDB mirror status + Duckling ClickHouse visibility
- `GET /cdc/status`
  - map to PeerDB mirror health / lag / last sync
- `POST /cdc/start`
  - resume mirrors
- `POST /cdc/stop`
  - pause mirrors

## Database config additions

`packages/server/src/database/databaseConfig.ts` should eventually carry PeerDB-specific metadata, for example:

```ts
interface PeerDBMirrorConfig {
  enabled: boolean;
  peerName: string;
  sourcePeerName: string;
  targetPeerName: string;
  mirrorPrefix?: string;
  tables?: string[];
}
```

Likely additions to each database config:

- PeerDB source peer name
- PeerDB target peer name
- mirror naming prefix
- optional included/excluded tables
- RustFS bucket/prefix if managed per database

## Suggested migration phases

### Phase 1: Infrastructure only

Add PeerDB stack and RustFS to local/dev infrastructure without changing Duckling runtime behavior.

Deliverables:

- new compose stack for PeerDB POC
- env/config variables for PeerDB + RustFS
- connectivity validation steps

### Phase 2: Orchestration service

Add a `PeerDBOrchestratorService` in Duckling that:

- creates peers
- creates mirrors
- pauses/resumes mirrors
- requests resync
- fetches mirror status

At this stage, keep old sync code present but unused by default.

### Phase 3: Endpoint remap

Route `sync/*` and `cdc/*` endpoints through PeerDB orchestration for selected databases.

At this stage, integration tests should validate ClickHouse results through PeerDB-managed replication.

### Phase 4: Cleanup

Delete in-repo replication internals once parity is proven:

- appender/watermark runtime
- automation sync scheduler
- CDC compatibility shim

## Concrete POC stack for this repo

Add a separate POC compose file rather than mutating the main dev compose first.

Suggested services:

- `clickhouse`
- `duckling-server`
- `duckling-frontend`
- `peerdb-catalog-postgres`
- `peerdb-temporal-postgres`
- `temporal`
- `temporal-ui`
- `peerdb-server`
- `flow-api`
- `flow-worker`
- `flow-snapshot-worker`
- `rustfs`

## Suggested env groups

### PeerDB core

```env
PEERDB_SERVER_HOST=peerdb-server
PEERDB_SERVER_PORT=9900
PEERDB_UI_URL=http://peerdb-ui:3000
```

### Catalog Postgres

```env
PEERDB_CATALOG_POSTGRES_HOST=peerdb-catalog-postgres
PEERDB_CATALOG_POSTGRES_PORT=5432
PEERDB_CATALOG_POSTGRES_DB=peerdb
PEERDB_CATALOG_POSTGRES_USER=peerdb
PEERDB_CATALOG_POSTGRES_PASSWORD=peerdb
```

### Temporal

```env
TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=default
```

### RustFS / S3 staging

```env
AWS_ACCESS_KEY_ID=<rustfs-access-key>
AWS_SECRET_ACCESS_KEY=<rustfs-secret-key>
AWS_ENDPOINT_URL_S3=http://rustfs:9000
AWS_REGION=us-east-1
PEERDB_S3_BUCKET=peerdb-stage
```

If PeerDB or ClickHouse require path-style behavior, make that explicit in the relevant service config.

### ClickHouse

```env
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_DATABASE=default
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
```

### MySQL source

Use the existing `MYSQL_CONNECTION_STRING`, but PeerDB will also need its own peer definition inputs.

## Peer naming strategy

Use deterministic names so Duckling can reconcile desired state safely.

Suggested convention:

- source peer: `mysql_<database_id>`
- target peer: `clickhouse_<database_id>`
- mirror/table prefix: `duckling_<database_id>_`

This avoids collisions across multiple Duckling databases.

## Migration contract for Duckling APIs

Duckling should preserve its external API shape where possible.

Expected behavior after migration:

- `sync/full`
  - ensure full snapshot / resync requested in PeerDB
- `sync/incremental`
  - ensure mirror is live
- `sync/status`
  - report PeerDB mirror status and ClickHouse table visibility
- `sync/validate`
  - compare MySQL counts against ClickHouse counts
- `cdc/status`
  - mirror lag / last sync / running state from PeerDB

## Validation checklist for the POC

Before replacing the current runtime path, verify:

1. Initial snapshot completes for representative tables.
2. Inserts appear in ClickHouse with acceptable lag.
3. Updates replace correctly in ClickHouse-visible tables.
4. Deletes propagate correctly.
5. JSON-bearing rows survive staging through RustFS.
6. Schema changes behave acceptably.
7. Restarting PeerDB services does not require manual repair.
8. ClickHouse can always reach RustFS.
9. Current self-hosted PeerDB ClickHouse CDC uses lowercase mirror columns:
   `_peerdb_synced_at` and `_peerdb_is_deleted`.
   This should be validated explicitly because some PeerDB docs/UI defaults still show uppercase `_PEERDB_*`.
10. The same setup works for your MySQL mode:
   - GTID
   - file-position
   - MariaDB

## Risks

### Operational complexity

PeerDB adds:

- Temporal
- extra Postgres
- object storage
- more services to monitor

### Documentation drift

Current docs are inconsistent for MySQL peers vs mirrors, so repo/tests matter more than one doc page.

### Staging dependency

If RustFS is unreachable from ClickHouse, replication will fail regardless of PeerDB health.

### Current type-compatibility blocker

The repo-local PeerDB type-coverage gate currently narrows the remaining compatibility risk to
zero-date handling on the MySQL -> PeerDB -> ClickHouse path.

Observed behavior:

- `0000-00-00` is materialized as `1970-01-01`
- `1000-01-01` / partial-zero date variants do not round-trip as originally expected

Tried workaround:

- create mirrors with a per-column destination override such as
  `col_date_zero -> String`

Current result:

- PeerDB still emits Avro logical `date` for that source column during snapshot
- ClickHouse then rejects loading into `String` on the current snapshot path
- concrete failure seen in the local PeerDB type gate:
  - `Type String is not compatible with Avro int`
  - payload schema carries Avro `{"type":"int","logicalType":"date"}`

Practical implication:

- the remaining blocker appears to be upstream PeerDB date handling rather than only Duckling-side orchestration

## Rollback plan

Keep the current Duckling replication path behind a feature flag during migration.

Suggested flag:

```env
REPLICATION_BACKEND=duckling
```

Valid values:

- `duckling`
- `peerdb`

Switching that flag should let you:

- keep the same Duckling APIs
- test PeerDB in one environment
- fall back quickly if needed

## Recommended implementation order in this repo

1. Add PeerDB/RustFS config support in `packages/server/src/config.ts`
2. Extend `DatabaseConfig` with PeerDB mirror metadata
3. Add `PeerDBOrchestratorService`
4. Add a separate PeerDB POC compose file
5. Wire `sync/*` and `cdc/*` endpoints to PeerDB behind `REPLICATION_BACKEND=peerdb`
6. Add integration tests for PeerDB-backed replication
7. Remove old replication internals only after parity is proven

## Immediate next step

Create:

- `docker-compose.peerdb.yml`
- PeerDB env/config support
- `PeerDBOrchestratorService` skeleton

That is the smallest concrete change set that starts the migration without breaking Duckling's existing query surfaces.
