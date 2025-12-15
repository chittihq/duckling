# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a high-performance DuckDB server service that replicates data from MySQL databases using a Sequential Appender architecture with ACID transactions. It provides a scalable analytical layer over operational MySQL data with 5-10x better query performance than traditional approaches.

## Monorepo Structure

This project uses **pnpm workspaces** to manage multiple packages:

```
duckling/
├── packages/
│   ├── server/          # @chittihq/duckling-server - DuckDB server with MySQL replication
│   │   ├── src/         # TypeScript source code
│   │   ├── public/      # Static web dashboard files
│   │   ├── dist/        # Compiled JavaScript (after build)
│   │   └── package.json
│   ├── frontend/        # @chittihq/duckling-frontend - Nuxt 4 web dashboard
│   │   ├── app/         # Nuxt pages, components, layouts
│   │   ├── assets/      # CSS and static assets
│   │   └── package.json
│   ├── sdk/             # @chittihq/duckling - WebSocket SDK for DuckDB queries
│   │   ├── src/         # SDK source code
│   │   ├── examples/    # Usage examples
│   │   └── package.json
│   └── shared/          # @chittihq/duckling-shared - Shared TypeScript types
│       ├── src/         # Shared types and constants
│       └── package.json
├── pnpm-workspace.yaml  # Workspace configuration
├── package.json         # Root package with workspace scripts
└── docker-compose.yml   # Development containers for server + frontend
```

### Package Dependencies

- **server** depends on: `shared`
- **frontend** depends on: `shared`, `sdk`
- **sdk** depends on: `shared`
- **shared** has no dependencies (foundation package)

## Development Commands

### Package Management
- Use `pnpm` instead of npm for all dependency management
- Install all dependencies: `pnpm install` (from root)
- Add package to specific workspace: `pnpm --filter @chittihq/duckling-server add <package-name>`
- Add package to root: `pnpm add -w <package-name>`

### Build & Development

**IMPORTANT:** Since development happens in Docker containers, always run build/lint commands **inside the running container**:

```bash
# ✅ CORRECT - Run commands inside Docker containers:
docker exec duckling-server pnpm run build:server
docker exec duckling-frontend pnpm run build:frontend
docker exec duckling-server pnpm run lint
docker exec duckling-frontend pnpm run lint

# ❌ WRONG - Don't run locally (different Node versions, missing dependencies):
pnpm run build:server
pnpm run lint
```

**Build Commands (run inside container):**
- Build server: `docker exec duckling-server pnpm run build:server`
- Build frontend: `docker exec duckling-frontend pnpm run build:frontend`
- Build SDK: `docker exec duckling-server pnpm run build:sdk`
- Build shared: `docker exec duckling-server pnpm run build:shared`
- Build all: `docker exec duckling-server pnpm run build`

**Lint Commands (run inside container):**
- Lint server: `docker exec duckling-server pnpm run lint`
- Lint frontend: `docker exec duckling-frontend pnpm run lint`

**Development Mode:**
- Development runs automatically in containers via docker-compose (hot reload enabled)
- No need to manually run `pnpm run dev` - containers start with dev mode by default
- Check logs: `docker-compose logs -f duckdb-server` or `docker-compose logs -f duckdb-frontend`

### CLI Operations (Server)

Run CLI commands **inside the Docker container**:

```bash
# Run CLI commands inside container
docker exec duckling-server node packages/server/dist/cli.js <command>

# Examples:
docker exec duckling-server node packages/server/dist/cli.js health
docker exec duckling-server node packages/server/dist/cli.js sync
docker exec duckling-server node packages/server/dist/cli.js tables
docker exec duckling-server node packages/server/dist/cli.js query "SELECT COUNT(*) FROM User"
```

**Available CLI Commands:**
- Health check: `docker exec duckling-server node packages/server/dist/cli.js health`
- Full sync: `docker exec duckling-server node packages/server/dist/cli.js sync`
- Incremental sync: `docker exec duckling-server node packages/server/dist/cli.js sync-incremental`
- System status: `docker exec duckling-server node packages/server/dist/cli.js status`
- Validate data: `docker exec duckling-server node packages/server/dist/cli.js validate`
- List tables: `docker exec duckling-server node packages/server/dist/cli.js tables`
- Execute query: `docker exec duckling-server node packages/server/dist/cli.js query "SELECT * FROM table_name"`

### MySQL Query Utility

Direct MySQL query execution (bypasses DuckDB, queries source directly):

```bash
# Run inside Docker container
docker exec duckling-server node scripts/mysql.js "SELECT COUNT(*) FROM User"
docker exec duckling-server node scripts/mysql.js "SHOW TABLES"
```

Returns JSON results. Uses `MYSQL_CONNECTION_STRING` from environment.

### Docker Development

**Development Environment:**
All development happens in a **docker-compose environment running in dev mode** with hot reload enabled:
- Both server and frontend run inside Docker containers
- Volume mounts sync local code changes to containers
- Hot reload automatically applies changes without restart
- No need to run `pnpm run dev` locally - containers handle it

**Docker Commands:**
- Start all services: `docker-compose up -d`
- View server logs: `docker-compose logs -f duckdb-server`
- View frontend logs: `docker-compose logs -f duckdb-frontend`
- Stop all services: `docker-compose down`

**Service Ports:**
- Server: http://localhost:3001 (backend API)
- Frontend: http://localhost:3000 (Nuxt 4 dashboard)

**IMPORTANT - When to Rebuild Docker:**
- ✅ **DO rebuild** (`--build` flag) when:
  - Adding/removing npm packages (any package.json changes)
  - Changing Dockerfile or docker-compose.yml
  - Updating system dependencies (apt packages)
  - Major structural changes (monorepo reorganization)

- ❌ **DON'T rebuild or restart** for:
  - Code changes in `.ts` or `.vue` files (hot reload via nodemon/Nuxt)
  - Configuration changes in `.env` files
  - View/template changes in `packages/server/public/` directory
  - Component changes in `packages/frontend/app/` directory
  - **Both containers use hot reload - changes apply automatically!**

**Hot Reload Details:**
- **Server (nodemon)**: Watches `.ts` files, auto-restarts Node.js process on changes
- **Frontend (Nuxt HMR)**: Watches `.vue`, `.ts` files, hot module replacement without page reload
- **No manual restart needed** - Just save your file and wait a few seconds

```bash
# ❌ WRONG - Don't do this for code changes:
docker-compose restart duckdb-server
docker-compose restart duckdb-frontend

# ✅ CORRECT - Just save the file and let hot reload handle it:
# (Make code changes, save file, hot reload detects and applies changes automatically)
```

**When to Restart (rarely needed):**
- Only restart if hot reload fails or you need to clear stuck state
- After changing environment variables in docker-compose.yml
- After modifying volume mounts or network settings

## Architecture Overview

### Sequential Appender Architecture

This service uses **Sequential Appender architecture** that provides:
- **5-10x faster queries** through DuckDB's columnar storage
- **ACID transactions** for guaranteed data integrity
- **Schema evolution** with zero-downtime updates
- **Watermark-based incremental sync** for efficient updates

### DuckDB Appender API (Unified Architecture)

The system uses a **unified @duckdb/node-api architecture** with high-performance Appender API for bulk loading:

**Performance Comparison:**
- **Traditional INSERT**: ~10,000 rows/sec (bulk INSERT with 2000-5000 rows/batch)
- **Appender API**: ~60,000+ rows/sec (direct binary append, 6x faster)

**Implementation Details:**
- **Unified Connection**: Uses only `@duckdb/node-api` for all operations (queries + appends)
- **Full Sync**: Uses Appender API for maximum speed (60M records in minutes vs hours)
- **Incremental Sync**: Uses INSERT OR REPLACE for upsert capability (handles updates)
- **Type Support**: All standard MySQL types supported with automatic type conversion
- **Instance Management**: Smart caching with fallback to `DuckDBInstance.create()` for problematic databases

**Supported Data Types:**
| MySQL Type | DuckDB Mapping | Appender Support | Notes |
|------------|----------------|------------------|-------|
| INTEGER, BIGINT, TINYINT, etc. | Same | ✅ | Direct mapping |
| VARCHAR, TEXT | VARCHAR | ✅ | String types |
| BLOB, BINARY, VARBINARY | BLOB | ✅ | Binary data (verified) |
| JSON | VARCHAR | ✅ | Stringified via JSON.stringify() |
| DATE, DATETIME, TIMESTAMP | DATE/TIMESTAMP | ✅ | Converted to ISO string |
| DECIMAL, NUMERIC | DECIMAL | ✅ | Exact numeric |
| BOOLEAN | BOOLEAN | ✅ | Boolean type |

**Key Benefits:**
- ✅ **60,000+ rows/sec** vs 10,000 rows/sec with INSERT
- ✅ **Unified architecture** - single package for all operations
- ✅ **No function argument limits** (INSERT has 65K limit due to V8)
- ✅ **Lower memory usage** (direct binary append, no SQL parsing)
- ✅ **All MySQL types supported** (JSON, BLOB, all numeric/date types)
- ✅ **Automatic fallback** (uses INSERT if Appender fails for any reason)
- ✅ **Smart cache handling** (bypasses cache for invalidated databases)

**Implementation:** `packages/server/src/database/duckdb.ts` (unified connection)
**Appender Usage:** `packages/server/src/services/sequentialAppenderService.ts`

### Core Components

#### Server Package (`packages/server/`)
- **Server Layer** (`src/server.ts`): Express.js application with RESTful API
- **Database Connections**:
  - `src/database/duckdb.ts` - Native DuckDB with columnar storage
  - `src/database/mysql.ts` - Source database operations
- **Sync Service** (`src/services/syncService.ts`):
  - Sequential Appender for ACID transactions
  - Streaming batch processing
  - Watermark-based incremental sync
  - Automatic error recovery
- **Static Dashboard** (`public/`): HTML/CSS/JS dashboard files

#### Frontend Package (`packages/frontend/`)
- **Nuxt 4 Application**: Modern Vue-based dashboard
- **Tailwind CSS**: Utility-first styling framework
- **shadcn-vue**: Beautiful UI components
- **Pages** (`app/pages/`): Dashboard, logs, tables, query interface
- **Components** (`app/components/ui/`): Reusable UI components

#### SDK Package (`packages/sdk/`)
- **WebSocket Client**: Real-time DuckDB query execution
- **Connection Pool**: Efficient connection management
- **TypeScript Support**: Full type safety for queries
- **Examples** (`examples/`): Usage patterns and best practices

#### Shared Package (`packages/shared/`)
- **TypeScript Types** (`src/types/`): Shared interfaces and types
- **Constants** (`src/constants/`): API routes, defaults, configs
- **Dual Build**: ESM and CJS support via tsup

### Data Flow
1. **MySQL Source** → **Sequential Appender** → **DuckDB Native Storage** → **API Clients**
2. Streaming batches from MySQL (10,000 records at a time)
3. ACID transactions ensure all-or-nothing writes
4. Watermark tracking for efficient incremental updates
5. Automatic schema detection and evolution

### Storage Structure
```
data/                         # Host path: ./data (maps to /app/data in container)
├── databases.json            # Multi-database configuration
├── {database_id}.db          # DuckDB file per database (persistent, columnar)
├── lms.db                    # Example: LMS database replica
└── chitti_common.db          # Example: Common database replica
```

**Note:** All paths shown are relative to the project root on the host. Inside Docker, these map to `/app/data/` via the volume mount `./data:/app/data` defined in `docker-compose.yml`.

### Multi-Database Support

The system supports **multiple isolated database replicas** running on a single server instance. Each database gets its own DuckDB file, connection pool, and sync service.

#### Key Features
- **Isolated Replicas**: Each MySQL source database gets its own DuckDB replica
- **Database Selector**: Frontend UI dropdown to switch between databases
- **Query Parameter**: All endpoints accept `?db={database_id}` to specify target database
- **Persistent Configuration**: Database configs stored in JSON file (see paths below)
- **Multi-Instance Architecture**: Separate connection pools per database to prevent cross-contamination

#### Database Configuration

**File Location:**
- **Host path** (for editing): `./data/databases.json` (relative to project root)
- **Container path**: `/app/data/databases.json` (via volume mount `./data:/app/data`)
- Changes to the host file are automatically reflected in the running container

**Schema:**
```json
[
  {
    "id": "lms",
    "name": "LMS",
    "mysqlConnectionString": "mysql://user:pass@host:port/chitti_lms?...",
    "duckdbPath": "data/lms.db",
    "createdAt": "2025-11-06T18:58:36.480Z",
    "updatedAt": "2025-11-06T18:58:36.480Z"
  }
]
```

#### Database Management APIs

**Create Database:**
```bash
curl -X POST http://localhost:3001/api/databases \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Database",
    "mysqlConnectionString": "mysql://...",
    "duckdbPath": "data/mydb.db"
  }'
```

**List Databases:**
```bash
curl http://localhost:3001/api/databases \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}"
```

**Update Database:**
```bash
curl -X PUT http://localhost:3001/api/databases/{id} \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Name"}'
```

**Delete Database:**
```bash
curl -X DELETE http://localhost:3001/api/databases/{id} \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}"
```

**Test Connection:**
```bash
curl -X POST http://localhost:3001/api/databases/{id}/test \
  -H "Authorization: Bearer ${DUCKLING_API_KEY}"
```

#### Using Multi-Database in API Calls

All data endpoints support the `?db={database_id}` query parameter:

```bash
# Sync specific database
curl -X POST 'http://localhost:3001/api/sync/full?db=lms' \
  -H 'Authorization: Bearer ${DUCKLING_API_KEY}'

# Query specific database
curl -X POST 'http://localhost:3001/api/query?db=lms' \
  -H 'Authorization: Bearer ${DUCKLING_API_KEY}' \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT COUNT(*) FROM User"}'

# Get tables from specific database
curl 'http://localhost:3001/api/tables?db=lms' \
  -H 'Authorization: Bearer ${DUCKLING_API_KEY}'
```

#### Frontend Integration

**Database Selector:**
- Located in header of all pages
- Persisted in localStorage for session continuity
- Automatically reloads page data when database changes

**Composable:** `packages/frontend/app/composables/useDatabase.ts`
```typescript
const { selectedDatabaseId, databases, setDatabase, getApiUrlWithDatabase } = useDatabase()

// Get API URL with database context
const url = getApiUrlWithDatabase('/tables') // Returns: /tables?db=lms

// Watch for database changes
watch(selectedDatabaseId, () => {
  loadData() // Reload page data when database changes
})
```

#### Architecture Implementation

**Multi-Instance Pattern:**
- **DuckDBConnection**: `Map<string, DuckDBConnection>` - One instance per database
- **MySQLConnection**: `Map<string, MySQLConnection>` - One connection pool per database
- **SequentialAppenderService**: `Map<string, SequentialAppenderService>` - One sync service per database

**Middleware:** `src/middleware/database.ts`
```typescript
export const attachDatabaseContext = (req, res, next) => {
  const databaseId = req.query.db || 'default';
  const dbConfig = DatabaseConfigManager.getInstance().getDatabase(databaseId);

  // Attach database-specific connections to request
  req.databaseId = databaseId;
  req.duckdb = DuckDBConnection.getInstance(databaseId, dbConfig.duckdbPath);
  req.mysql = MySQLConnection.getInstance(databaseId, dbConfig.mysqlConnectionString);

  next();
}
```

**Benefits:**
- ✅ **Zero Cross-Contamination**: Complete isolation between databases
- ✅ **Efficient Resource Usage**: Connection pooling per database
- ✅ **Single Server**: No need to deploy multiple instances
- ✅ **Unified Monitoring**: All databases visible in one dashboard
- ✅ **Easy Management**: CRUD operations via REST API

### Query Performance Benefits
- **Columnar Storage**: DuckDB's native columnar format for fast analytical queries
- **Column Pruning**: Read only needed columns
- **Compressed Storage**: DuckDB's built-in compression
- **In-Process Queries**: No network overhead

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
Query specific table to check for duplicates:
```bash
curl -X POST http://localhost:3001/api/query \
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
  - `ENABLE_INCREMENTAL_SYNC`: Enable incremental sync mode (default: **true** - set to `false` to disable)
  - `MAX_RETRIES`: Retry attempts for failed operations (default: 3)
  - `AUTO_START_SYNC`: Auto-start sync on container boot (default: **true** - set to `false` to disable)
  - `EXCLUDED_TABLES`: Comma-separated list of tables to exclude (default: none)

- **Automation Configuration** (Zero Manual Intervention - All Enabled by Default):
  - `AUTO_CLEANUP`: Enable automatic cleanup tasks (default: **true** - set to `false` to disable)
  - `CLEANUP_INTERVAL_HOURS`: Hours between cleanup runs (default: 24)
  - `RETENTION_DAYS`: Retention period for cleanup tasks (default: 90)
  - `AUTO_BACKUP`: Enable automatic backups (default: **true** - set to `false` to disable)
  - `BACKUP_INTERVAL_HOURS`: Hours between backups (default: 24)
  - `BACKUP_RETENTION_DAYS`: Days to retain backups (default: 7)
  - `AUTO_RESTART`: Enable auto-restart on failures (default: **true** - set to `false` to disable)
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

**Multi-Database Support:**
All data endpoints (health, sync, tables, query) accept the `?db={database_id}` query parameter to specify which database to operate on. If omitted, defaults to `default` database.

### Database Management
- `GET /api/databases` - List all configured databases
- `POST /api/databases` - Add new database configuration
- `PUT /api/databases/:id` - Update database configuration
- `DELETE /api/databases/:id` - Remove database configuration
- `POST /api/databases/:id/test` - Test database connection

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
Always build and test CLI commands inside Docker before modifying database operations:
```bash
# Build inside container
docker exec duckling-server pnpm run build:server

# Test CLI commands
docker exec duckling-server node packages/server/dist/cli.js health
docker exec duckling-server node packages/server/dist/cli.js sync
```

### Memory Management
- Batch processing prevents memory overflow on large datasets
- Connection pooling limits concurrent database connections
- Graceful shutdown handling for cleanup

## Production Deployment

### SystemD Service
- Service file: `scripts/deploy/duckdb-server.service`
- Installation script: `scripts/deploy/install.sh`
- Update script: `scripts/deploy/update.sh`

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
- Multi-instance pattern for database connections (Map-based caching per database ID)
- Express middleware pattern for request handling and database context injection
- Error-first callback conversion to Promises
- Environment-based configuration with sensible defaults

## Automation & Failsafe Features

This DuckDB server includes comprehensive automation for zero manual intervention. **All automation features are ENABLED by default** - set environment variables to `false` to disable specific features if needed.

### 1. Automatic Sync (Every 15 Minutes) - Enabled by Default
- Auto-starts on container boot (default: `AUTO_START_SYNC=true`)
- Incremental sync every 15 minutes (`SYNC_INTERVAL_MINUTES=15`)
- No duplicates (default: `ENABLE_INCREMENTAL_SYNC=true`)
- Syncs all tables automatically
- **To disable:** Set `AUTO_START_SYNC=false` in `.env`

### 2. Automatic Storage Cleanup (Daily) - Enabled by Default
- Runs every 24 hours (default: `AUTO_CLEANUP=true`, `CLEANUP_INTERVAL_HOURS=24`)
- DuckDB handles storage management automatically (VACUUM, WAL cleanup)
- Sequential Appender architecture uses native DuckDB files (no partition cleanup needed)
- Reserved for future cleanup tasks (old logs, temp files, etc.)
- **To disable:** Set `AUTO_CLEANUP=false` in `.env`

### 3. Automatic Backup & Recovery (Daily) - Enabled by Default
- Backs up every 24 hours (default: `AUTO_BACKUP=true`, `BACKUP_INTERVAL_HOURS=24`)
- Keeps 7 days of backups (`BACKUP_RETENTION_DAYS=7`)
- Backs up DuckDB database + metadata
- Auto-cleanup of old backups
- One-command restore: `POST /automation/restore`
- **To disable:** Set `AUTO_BACKUP=false` in `.env`

### 4. Health Monitoring & Auto-Restart - Enabled by Default
- Monitors connections every 60 seconds (default: `AUTO_RESTART=true`)
- Auto-recovers from failures (up to 3 attempts: `MAX_RESTART_ATTEMPTS=3`)
- Auto-reconnects DuckDB and MySQL on failures
- Exponential backoff retry strategy
- Auto-triggers sync to verify recovery
- **To disable:** Set `AUTO_RESTART=false` in `.env`

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
- ✅ Storage managed by DuckDB automatically (VACUUM, WAL)
- ✅ Backups created daily (7 day retention)
- ✅ Health monitoring every 60 seconds
- ✅ Auto-reconnects on database failures
- ✅ Auto-restores from latest backup on critical failures
- ✅ Self-heals views and schema changes

### Implementation Details

The automation is powered by `AutomationService` (`src/services/automationService.ts`):
- Multi-instance service (one per database) started with server
- Manages cleanup, backup, and health check intervals
- Integrates with `SequentialAppenderService` for health tracking
- Provides manual override endpoints for emergency operations
- Respects `?db={database_id}` parameter for multi-database support
- Always build inside container: `docker exec duckling-server pnpm run build:server`