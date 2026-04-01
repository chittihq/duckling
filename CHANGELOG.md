# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, with the latest unreleased work listed first.

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
