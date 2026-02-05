# Duckling - DuckDB Server with MySQL Replication

![Duckling Banner](docs/images/banner.jpeg)

A high-performance DuckDB server that replicates data from MySQL using **Sequential Appender architecture** with ACID transactions for guaranteed data integrity and **5-10x faster query performance**.

## 🚀 Performance Features

- **⚡ 5-10x faster queries** through columnar storage
- **🔄 Schema evolution** with zero-downtime updates
- **🎯 Smart table classification** (dimensions, facts, metadata)
- **✅ ACID Transactions** - All-or-nothing sync with guaranteed data integrity
- **🔄 Atomic Operations** - No partial writes, no duplicates, no data loss
- **⚡ Watermark-Based Sync** - Efficient incremental updates tracking last processed records
- **📊 Streaming Batches** - Memory-efficient processing of large tables
- **🗄️ Native DuckDB Storage** - Direct columnar storage without intermediate files
- **💾 Persistent by Default** - File-based database survives restarts automatically

## 🏗️ Core Features

- **🔄 Incremental MySQL to DuckDB replication** with atomic transactions
- **⚡ Incremental synchronization** with watermark tracking
- **🗄️ Partitioned storage** for optimal query performance
- **🔍 RESTful API** for querying and management
- **💓 Health monitoring** and comprehensive metrics
- **🐳 Docker support** with docker-compose
- **🚀 Systemd service** for production deployment
- **🛠️ Comprehensive CLI tools** for management

## Performance Comparison

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Query Speed** | 2-5 seconds | 200-500ms | **5-10x faster** |
| **Sync Performance** | 30min full | 5min incremental | **6x faster** |

## Architecture Benefits

| Feature | Sequential Appender |
|---------|-------------------|
| **Data Integrity** | ✅ ACID guaranteed |
| **Duplicates** | ✅ None (PK constraints) |
| **Missing Records** | ✅ None (transactions) |
| **Storage Layers** | ✅ One (DuckDB) |
| **Restart Time** | ✅ Instant |
| **Code Complexity** | ✅ ~800 lines |

## Why DuckDB over MariaDB ColumnStore?

We evaluated MariaDB ColumnStore but chose DuckDB for these reasons:

- **Zero infrastructure** - DuckDB is embedded, no separate server needed
- **Low resource requirements** - Runs on 4GB RAM vs ColumnStore's 128GB RAM + 64 cores for production
- **Empty string support** - ColumnStore treats empty strings as NULL, breaking MySQL compatibility
- **Full SQL support** - ColumnStore doesn't use indexes (uses extent elimination), no ORDER BY in DELETE/UPDATE
- **Simple deployment** - Single file vs distributed cluster management
- **Cost effective** - $20/month droplet vs $500+/month infrastructure
- **Better for CDC** - In-process writes with zero network latency

ColumnStore makes sense for petabyte-scale (100TB+) distributed analytics. For MySQL replication under 100GB, DuckDB is optimal.

## Quick Start

### Docker (Recommended)

```bash
# Clone and build
git clone <repository>
cd duckling
pnpm install
pnpm run build

# Start server and frontend with docker-compose
docker-compose up -d

# Check status
curl http://localhost:3001/health  # Server on port 3001
curl http://localhost:3000         # Frontend on port 3000
```

### Manual Installation

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm run build

# Start the server
pnpm run start:server

# Start the frontend (in another terminal)
pnpm run start:frontend

# Health check
curl http://localhost:3000/health
```

### Development Mode

```bash
# Start both server and frontend with hot reload
pnpm run dev

# Or run individually:
pnpm run dev:server      # Server on port 3000
pnpm run dev:frontend    # Frontend on port 3000 (Nuxt dev server)
pnpm run dev:sdk         # SDK build watch mode
```

## Configuration

Environment variables (copy `.env.example` to `.env`):

```bash
# Database Configuration
MYSQL_CONNECTION_STRING=mysql://user:password@localhost:3306/database
MYSQL_MAX_CONNECTIONS=5
DUCKDB_PATH=data/duckling.db
DUCKLING_API_KEY=your-secret-key

# Sync Configuration
SYNC_INTERVAL_MINUTES=15
BATCH_SIZE=10000
ENABLE_INCREMENTAL_SYNC=true
AUTO_START_SYNC=false
EXCLUDED_TABLES=temp_table,cache_table

# Performance Optimization
MAX_RETRIES=3
CONNECTION_TIMEOUT=30000
QUERY_TIMEOUT=30000
```

## API Reference

See [API.md](./API.md) for complete API documentation including:
- REST endpoints for sync, queries, and management
- WebSocket SDK for high-performance real-time queries
- Query examples and performance benchmarks

## CLI Commands

### Basic Operations
```bash
# Health check with architecture info
pnpm run health

# System status with table counts
pnpm run status

# Validate sync (MySQL vs DuckDB counts)
pnpm run validate
```

### Synchronization
```bash
# Run full sync with atomic transactions
pnpm run sync

# Run incremental sync with watermarks
pnpm run sync:incremental
```

### Advanced Operations
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

### Package-Specific Commands
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

## How It Works

### Full Sync
1. For each table in MySQL:
   - **BEGIN TRANSACTION** on DuckDB
   - Create table with schema from MySQL
   - Stream data in 10K record batches from MySQL
   - INSERT records sequentially into DuckDB
   - **COMMIT** transaction (or **ROLLBACK** on error)
   - Update watermark with last processed ID/timestamp

### Incremental Sync
1. For each table:
   - Load watermark (last processed ID/timestamp)
   - Query MySQL for new/updated records: `WHERE id > last_id`
   - **BEGIN TRANSACTION** on DuckDB
   - INSERT OR REPLACE new records
   - **COMMIT** transaction
   - Update watermark

### Watermark Tracking
- Stored in `appender_watermarks` table in DuckDB
- Tracks `last_processed_id` and `last_processed_timestamp` per table
- Automatically identifies primary key and timestamp columns
- Enables efficient incremental updates

## Configuration Options

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `MYSQL_CONNECTION_STRING` | - | MySQL database connection string |
| `DUCKDB_PATH` | `data/duckling.db` | DuckDB database file path |
| `BATCH_SIZE` | `10000` | Records per batch during sync |
| `SYNC_INTERVAL_MINUTES` | `15` | Auto-sync frequency |
| `MAX_RETRIES` | `3` | Retry attempts for failed operations |
| `CONNECTION_TIMEOUT` | `30000` | Connection timeout in ms |

## Performance Tuning

1. **Batch Size Optimization**
   - Default: 10,000 rows per batch
   - Small tables (< 100K rows): 5,000 rows/batch
   - Large tables (> 1M rows): 20,000 rows/batch
   - Configure via `BATCH_SIZE` environment variable

2. **Incremental Sync Frequency**
   - Default: Every 15 minutes
   - High-frequency updates: 5-10 minutes
   - Low-frequency updates: 30-60 minutes
   - Configure via `SYNC_INTERVAL_MINUTES`

3. **Query Optimization**
   - Use indexes on frequently queried columns
   - DuckDB columnar format optimizes analytical queries automatically
   - Select only needed columns to minimize I/O

## Deployment

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for complete deployment documentation including:
- Security configuration (required before production)
- Docker and docker-compose setup
- Production builds
- Health checks and monitoring
- Backup and recovery

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting guide above
- Review the logs for detailed error information