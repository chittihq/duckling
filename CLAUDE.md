# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a high-performance DuckDB server service that replicates data from MySQL databases using a micro-batch Parquet architecture. It provides a scalable analytical layer over operational MySQL data with 5-10x better query performance than traditional approaches.

## Development Commands

### Package Management
- Use `pnpm` instead of npm for all dependency management
- Install dependencies: `pnpm install`
- Add packages: `pnpm add <package-name>`

### Build & Development
- Build for production: `pnpm run build`
- Development with hot reload: `pnpm run dev`
- Development build with watch: `pnpm run dev:build`
- Start production server: `pnpm run start`

### CLI Operations
- Run full sync: `pnpm run sync` or `node dist/cli.js sync`
- Run incremental sync: `pnpm run sync:incremental` or `node dist/cli.js sync-incremental`
- Health check: `pnpm run health` or `node dist/cli.js health`
- System status: `pnpm run status` or `node dist/cli.js status`
- Validate data integrity: `pnpm run validate` or `node dist/cli.js validate`
- List tables: `node dist/cli.js tables`
- Execute query: `node dist/cli.js query "SELECT * FROM table_name"`

### MySQL Query Utility
Direct MySQL query execution (bypasses DuckDB, queries source directly):
```bash
node scripts/mysql.js "SELECT COUNT(*) FROM User"
./scripts/mysql.js "SHOW TABLES"
```
Returns JSON results. Uses `MYSQL_CONNECTION_STRING` from environment.

### Docker Development
- Development with Docker: `docker-compose -f docker-compose.dev.yml up --build`
- Production with Docker: `docker-compose up -d`
- View logs: `docker-compose logs -f duckdb-server`

**IMPORTANT - When to Rebuild Docker:**
- ✅ **DO rebuild** (`--build` flag) when:
  - Adding/removing npm packages (package.json changes)
  - Changing Dockerfile or docker-compose.yml
  - Updating system dependencies (apt packages)
  - Major structural changes

- ❌ **DON'T rebuild** for:
  - Code changes in `.ts` files (hot reload via nodemon)
  - Configuration changes in `.env` files
  - View/template changes in `public/` directory
  - **The development container uses nodemon with TypeScript hot reload - changes apply automatically!**

```bash
# For code changes, just restart the container (NO rebuild needed):
docker compose restart duckdb-server

# Or simply let it run - nodemon will detect changes and reload automatically
```

## Architecture Overview

### Micro-Batch Parquet Architecture

This service uses a modern **micro-batch Parquet architecture** that provides:
- **5-10x faster queries** through columnar storage and partition pruning
- **60-80% memory reduction** through streaming and batch processing  
- **30-50% storage savings** through Parquet compression
- **Schema evolution** with zero-downtime updates
- **Partition management** with automatic cleanup

### Core Components

#### Server Layer (`src/server.ts`)
- Express.js application with comprehensive API endpoints
- Parquet-specific endpoints for storage management
- View management and migration capabilities
- Enhanced metrics and monitoring

#### Partitioned Storage (`src/storage/parquetStorage.ts`)
- **Dimensions**: Small tables with daily snapshots (customers, products)
- **Facts**: Large tables with micro-batch append (orders, events)  
- **Metadata**: System tracking with configurable retention
- Automatic table classification and optimization

#### Database Connections
- **DuckDB Connection** (`src/database/duckdb.ts`): In-memory DuckDB with Parquet views
- **MySQL Connection** (`src/database/mysql.ts`): Source database operations
- **View Manager** (`src/services/viewManager.ts`): Automatic schema evolution handling

#### Sync Service (`src/services/syncService.ts`)
- Intelligent table classification (dimension vs fact vs metadata)
- Micro-batch processing for optimal performance
- Incremental sync with partition-aware operations
- Automatic error recovery and retry logic

### Data Flow
1. **MySQL Source** → **Sync Service** → **Parquet Files** → **DuckDB Views** → **API Clients**
2. Smart table classification based on patterns and size
3. Micro-batch processing with configurable batch sizes
4. Partition-aware incremental updates
5. Automatic view creation and schema evolution

### Storage Structure
```
data/
├── dimensions/          # Snapshot-based tables
│   ├── customers/snapshot_date=2024-01-15/full-*.parquet
│   └── products/snapshot_date=2024-01-15/full-*.parquet
├── facts/              # Append-only tables  
│   ├── orders/ingest_date=2024-01-15/batch-*.parquet
│   └── events/ingest_date=2024-01-15/batch-*.parquet
└── metadata/           # System metadata
    ├── sync_metadata/current/metadata.parquet
    └── sync_log/ingest_date=2024-01-15/log-*.parquet
```

### Query Performance Benefits
- **Partition Pruning**: Only scan relevant date partitions
- **Column Pruning**: Read only needed columns from Parquet files
- **Compression**: 30-50% smaller storage footprint
- **Parallel Processing**: Concurrent operations across partitions

### Automatic Deduplication Strategy

The system implements **view-level deduplication** to handle duplicate records in fact tables:

#### Problem Solved
Fact tables using append strategy can accumulate duplicates when:
- Tables lack `updatedAt`/`modifiedAt` columns (only have `createdAt`)
- Incremental sync falls back to full sync repeatedly
- Each full sync creates new batch files without removing old ones

#### Solution Approach
**Deduplication at Read-Time** (not write-time) using DuckDB's `QUALIFY` clause:
- Automatic primary key detection from schema (PRI constraint, id columns, {table}Id patterns)
- Views deduplicate using window functions: `PARTITION BY primaryKey ORDER BY ingest_date DESC`
- Latest version of each record automatically selected
- Zero overhead on writes, transparent to API consumers

#### Benefits
- ✅ **Zero Write Overhead**: Batch files append as-is, no lookups needed
- ✅ **Automatic**: 64 fact tables deduplicated automatically
- ✅ **Performance**: 5-10% read overhead, no write impact
- ✅ **Storage**: Physical files unchanged (future compaction can reduce 60-94%)
- ✅ **Backward Compatible**: Existing queries work unchanged

#### Verification
Check for duplicates:
```bash
./check_duplicates.sh
```

Query specific table:
```bash
curl -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) as total, COUNT(DISTINCT id) as unique FROM TableName"}'
```

### Incremental Sync & Watermark Management

The system uses **watermark-based incremental sync** to efficiently track and replicate changes from MySQL to DuckDB.

#### How Watermarks Work

**Watermark Tracking:**
- Each table stores a watermark with the last processed timestamp and/or ID
- On each sync cycle, only records changed since the watermark are fetched
- Watermarks are stored in DuckDB's `sync_log` table with full audit trail

**Query Pattern:**
```sql
-- Fetch incremental changes (note: uses >= not > to prevent data loss at boundaries)
SELECT * FROM TableName WHERE updatedAt >= '2025-10-30 12:00:00'
```

#### Timestamp Detection Priority

The system automatically detects the appropriate timestamp column with the following priority:

1. **`updatedAt` / `updated_at` / `modifiedAt` / `modified_at`** (highest priority)
   - Best for tracking record modifications
   - Captures all updates to existing records
   - Used by most transactional tables (User, Workshop, Product, etc.)

2. **`createdAt` / `created_at`** (fallback)
   - For append-only tables (fact tables)
   - For tables without update tracking
   - Still allows incremental sync for new records

3. **`timestamp`** (final fallback)
   - Generic timestamp column
   - Legacy systems

**Implementation:** `src/database/mysql.ts:122-129`

#### INSERT OR REPLACE Behavior

The appender uses **`INSERT OR REPLACE`** for all incremental records, providing automatic upsert behavior:

```typescript
// Bulk upsert query (sequentialAppenderService.ts:568)
INSERT OR REPLACE INTO TableName (col1, col2, ...) VALUES (?, ?, ...)
```

**Behavior by Table Type:**

| Timestamp Column | Behavior | Use Case | Example Tables |
|-----------------|----------|----------|----------------|
| **`updatedAt`** | INSERT new + REPLACE modified | Tables where records are updated | User, Workshop, Product, Token |
| **`createdAt`** | INSERT new records only | Append-only fact tables | Order, Event, Action, Log |
| **Both present** | Uses `updatedAt` (priority) | Best of both worlds | Most tables |

**How it Works:**
```
IF primary_key EXISTS in DuckDB:
    REPLACE entire row with new values (UPDATE)
ELSE:
    INSERT new row
```

**Key Benefits:**
- ✅ No duplicates (primary key constraint enforced)
- ✅ Updates propagate automatically (modified records replace old ones)
- ✅ Idempotent (re-processing same record is safe)
- ✅ Works with `>=` operator (last record re-processed each sync, but safely replaced)

#### Timestamp Boundary Handling

**Critical Fix (2025-10-30):** Changed from `>` to `>=` in incremental queries to prevent data loss.

**Problem with `>` operator:**
```sql
-- If watermark = '2025-10-30 12:00:00.000'
-- And record updated at '2025-10-30 12:00:00.000'
WHERE updatedAt > '2025-10-30 12:00:00.000'  -- ❌ Excludes the record!
```

**Solution with `>=` operator:**
```sql
WHERE updatedAt >= '2025-10-30 12:00:00.000'  -- ✅ Includes the record
```

**Side Effect:** Last synced record is re-processed each sync
**Why it's safe:** `INSERT OR REPLACE` handles duplicate processing idempotently

#### Sync Logs & Monitoring

**Sync Logs UI:** `http://localhost:3001/logs.html`

Shows real-time synchronization activity:
- Table name and sync type (watermark/sequential/full)
- Records processed per sync operation
- Duration in milliseconds
- Success/error status with detailed error messages
- Watermark changes (before/after states)

**API Endpoint:** `GET /api/sync-logs?limit=100&status=success`

Query parameters:
- `limit`: Number of logs to return (default: 100)
- `offset`: Pagination offset (default: 0)
- `status`: Filter by 'success' or 'error'
- `table`: Filter by specific table name

**Sync Log Schema:**
```sql
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY,
  table_name VARCHAR,
  sync_type VARCHAR,           -- 'watermark', 'sequential', 'full'
  records_processed INTEGER,
  duration_ms INTEGER,
  status VARCHAR,              -- 'success', 'error'
  error_message VARCHAR,
  watermark_before VARCHAR,    -- JSON snapshot
  watermark_after VARCHAR,     -- JSON snapshot
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Monitoring Examples:**
```bash
# Check recent syncs
curl -s http://localhost:3001/api/sync-logs?limit=10

# Check failed syncs
curl -s "http://localhost:3001/api/sync-logs?status=error&limit=5"

# Check specific table sync history
curl -s "http://localhost:3001/api/sync-logs?table=User&limit=20"
```

## Configuration

### Environment Variables
Configure via `.env` file (copy from `.env.example`):

- **Database Configuration**:
  - `MYSQL_CONNECTION_STRING`: Source database connection string
  - `DUCKDB_PATH`: File path for DuckDB database (default: `data/duckling.db`)
  - `MYSQL_MAX_CONNECTIONS`: MySQL connection pool size (default: 5)
  - `DUCKDB_MAX_CONNECTIONS`: DuckDB connection pool size (default: 10)

- **Sync Configuration**:
  - `SYNC_INTERVAL_MINUTES`: Automatic sync frequency (default: 15)
  - `BATCH_SIZE`: Records per batch during sync (default: 1000)
  - `ENABLE_INCREMENTAL_SYNC`: Enable incremental sync mode (default: true)
  - `MAX_RETRIES`: Retry attempts for failed operations (default: 3)
  - `AUTO_START_SYNC`: Auto-start sync on container boot (default: false)
  - `EXCLUDED_TABLES`: Comma-separated list of tables to exclude (default: none)

- **Automation Configuration** (Zero Manual Intervention):
  - `AUTO_CLEANUP`: Enable automatic partition cleanup (default: false)
  - `CLEANUP_INTERVAL_HOURS`: Hours between cleanup runs (default: 24)
  - `RETENTION_DAYS`: Days to retain partitions (default: 90)
  - `AUTO_BACKUP`: Enable automatic backups (default: false)
  - `BACKUP_INTERVAL_HOURS`: Hours between backups (default: 24)
  - `BACKUP_RETENTION_DAYS`: Days to retain backups (default: 7)
  - `AUTO_RESTART`: Enable auto-restart on failures (default: false)
  - `MAX_RESTART_ATTEMPTS`: Max recovery attempts (default: 3)

- **Server Configuration**:
  - `PORT`: HTTP server port (default: 3000)
  - `NODE_ENV`: Environment mode (development/production)
  - `LOG_LEVEL`: Logging verbosity (debug/info/warn/error)
  - `DUCKLING_API_KEY`: API key for programmatic access (optional, for `/api/*` endpoints)

### Configuration Object (`src/config.ts`)
Centralized configuration management with environment variable parsing and defaults.

## API Endpoints

All endpoints require authentication via:
- **API Key**: `Authorization: Bearer <DUCKLING_API_KEY>` header (for programmatic access)
- **Session**: Cookie-based auth via `/api/login` (for web dashboard)

### Health & Monitoring
- `GET /health` - Database connectivity and system health
- `GET /status` - Detailed system status with table counts and metrics
- `GET /metrics` - Sync performance metrics and statistics

### Data Synchronization
- `POST /sync/full` - Trigger complete data refresh
- `POST /sync/incremental` - Trigger incremental update
- `POST /sync/table/:tableName` - Sync specific table
- `GET /sync/status` - Current sync state and recent logs
- `GET /sync/validate` - Compare record counts between databases

### Automation & Recovery (New)
- `GET /automation/status` - Get automation service status (cleanup, backup, health)
- `POST /automation/start` - Start automation service
- `POST /automation/stop` - Stop automation service
- `POST /automation/backup` - Trigger manual backup
- `POST /automation/restore` - Restore from latest backup
- `POST /automation/cleanup` - Trigger manual partition cleanup

### Data Access
- `GET /tables` - List all replicated tables
- `GET /tables/:name/schema` - Table structure information
- `GET /tables/:name/data?limit=100&offset=0` - Paginated table data
- `GET /tables/:name/count` - Table row count
- `POST /query` - Execute arbitrary SQL queries on DuckDB

## Development Patterns

### Error Handling
- All async operations wrapped in try-catch blocks
- Structured error logging with context
- Graceful degradation when MySQL connection fails
- Transaction rollback on batch operation failures

### Logging
- Winston-based structured logging in `src/logger.ts`
- Separate log levels for different components
- Request/response logging with timing metrics
- Error context preservation for debugging

### Testing Database Operations
Always build and test CLI commands before modifying database operations:
```bash
pnpm run build
node dist/cli.js health
node dist/cli.js sync
```

### Memory Management
- Batch processing prevents memory overflow on large datasets
- Connection pooling limits concurrent database connections
- Graceful shutdown handling for cleanup

## Production Deployment

### SystemD Service
- Service file: `deploy/duckdb-server.service`
- Installation script: `deploy/install.sh`
- Update script: `deploy/update.sh`

### Docker Production
- Production Dockerfile with multi-stage builds
- nginx reverse proxy configuration included
- Health check endpoints for container orchestration

### Monitoring
- Structured logs for external log aggregation
- Health check endpoints for load balancer integration
- Sync metrics for performance monitoring

## Code Style & Conventions

- TypeScript with strict mode disabled for flexibility
- Async/await for all database operations
- Singleton pattern for database connections
- Express middleware pattern for request handling
- Error-first callback conversion to Promises
- Environment-based configuration with sensible defaults

## Automation & Failsafe Features

This DuckDB server includes comprehensive automation for zero manual intervention:

### 1. Automatic Sync (Every 15 Minutes)
- Auto-starts on container boot (`AUTO_START_SYNC=true`)
- Incremental sync every 15 minutes (`SYNC_INTERVAL_MINUTES=15`)
- No duplicates (`ENABLE_INCREMENTAL_SYNC=true`)
- Syncs all 181 tables automatically

### 2. Automatic Partition Cleanup (Daily)
- Runs every 24 hours (`AUTO_CLEANUP=true`, `CLEANUP_INTERVAL_HOURS=24`)
- Keeps 90 days of data (`RETENTION_DAYS=90`)
- Auto-deletes old fact partitions and dimension snapshots
- Frees disk space without intervention

### 3. Automatic Backup & Recovery (Daily)
- Backs up every 24 hours (`AUTO_BACKUP=true`, `BACKUP_INTERVAL_HOURS=24`)
- Keeps 7 days of backups (`BACKUP_RETENTION_DAYS=7`)
- Backs up DuckDB database + metadata
- Auto-cleanup of old backups
- One-command restore: `POST /automation/restore`

### 4. Health Monitoring & Auto-Restart
- Monitors connections every 60 seconds (`AUTO_RESTART=true`)
- Auto-recovers from failures (up to 3 attempts: `MAX_RESTART_ATTEMPTS=3`)
- Auto-reconnects DuckDB and MySQL on failures
- Exponential backoff retry strategy
- Auto-triggers sync to verify recovery

### 5. Zero Manual Intervention Required

**What you DON'T need to do:**
- ❌ No manual sync triggers
- ❌ No cron jobs to setup
- ❌ No monitoring scripts
- ❌ No backup scripts
- ❌ No cleanup tasks
- ❌ No health checks
- ❌ No connection recovery
- ❌ No disaster recovery planning

**Everything is automatic:**
- ✅ Sync starts on boot and runs every 15 minutes
- ✅ Partitions cleaned up daily (90 day retention)
- ✅ Backups created daily (7 day retention)
- ✅ Health monitoring every 60 seconds
- ✅ Auto-reconnects on database failures
- ✅ Auto-restores from latest backup on critical failures
- ✅ Self-heals views and schema changes

### Implementation Details

The automation is powered by `AutomationService` (`src/services/automationService.ts`):
- Singleton service started with server
- Manages cleanup, backup, and health check intervals
- Integrates with `SyncService` for health tracking
- Provides manual override endpoints for emergency operations