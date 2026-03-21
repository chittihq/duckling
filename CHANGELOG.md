# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, with the latest unreleased work listed first.

## [Unreleased]

### Added

- Docker image publishing workflow for release tags via `.github/workflows/docker-publish.yml`.
- Resumable full sync for primary-key-backed tables.
  - Full sync progress is now tracked in the internal `full_sync_sessions` DuckDB table.
  - Interrupted full syncs resume from the last flushed primary-key cursor instead of restarting from row 1.
  - `swapping` sessions resume the final cutover without rereading MySQL.
  - New config flag: `FULL_SYNC_RESUME_ENABLED` (enabled by default).

### Changed

- Internal DuckDB maintenance work now bypasses normal query-governor timeouts.
  - Internal `run()` / `executeInternal()` queries can disable timeout enforcement.
  - `CHECKPOINT` is no longer subject to the standard 30s governor timeout.
  - Health checks and recovery attempts now stand down while sync or backup work is active.
- Frontend upgraded to Nuxt `4.4.2`.

### Fixed

- Full sync and incremental staging merges now align insert columns by name instead of relying on positional `SELECT *` swaps.
  - This prevents schema-drift bugs where values could be written into the wrong target columns when DuckDB column order diverged from fresh staging tables.
- `clear all data` now also clears resumable full-sync metadata so stale sessions do not survive a reset.

### Notes

- Schema evolution is still primarily additive. New columns are handled automatically, but dropped columns or incompatible type changes may still require a rebuild/full resync of the affected table.

## [0.1.0] - 2026-03-22

Initial tagged release.

### Included

- MySQL to DuckDB replication with full sync, watermark-based incremental sync, and optional CDC.
- Query access over REST, WebSocket, and the MySQL wire protocol.
- Nuxt frontend dashboard.
- Backup, sync automation, and Docker-based deployment support.
