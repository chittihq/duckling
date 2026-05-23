# CLI Commands

> ⚠️ **Legacy doc (DuckDB era).** Some pnpm scripts referenced below have changed or been removed (e.g. there is no `pnpm run health` script anymore — `curl /health?db=<id>` works instead). The active CLI is `node packages/server/dist/cli.js <command>`, documented under "CLI Operations (Server)" in `CLAUDE.md`. Treat the table below as historical.

---

## Basic Operations
```bash
# Health check with architecture info
pnpm run health

# System status with table counts
pnpm run status

# Validate sync (MySQL vs DuckDB counts)
pnpm run validate
```

## Synchronization
```bash
# Run full sync with atomic transactions
pnpm run sync

# Run incremental sync with watermarks
pnpm run sync:incremental
```

## Advanced Operations
```bash
# Execute queries on DuckDB
node packages/server/dist/cli.js query "SELECT COUNT(*) FROM orders WHERE order_date >= '2024-01-01'"

# List all tables
node packages/server/dist/cli.js tables

# Check sync status
node packages/server/dist/cli.js status

# Validate data integrity
node packages/server/dist/cli.js validate
```

## Package-Specific Commands
```bash
# Build specific package
pnpm run build:server
pnpm run build:frontend
pnpm run build:sdk
pnpm run build:shared

# Run specific package in dev mode
pnpm run dev:server
pnpm run dev:frontend
pnpm run dev:sdk

# Type checking across all packages
pnpm run typecheck
```
