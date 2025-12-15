# Duckling - DuckDB Server with MySQL Replication

A high-performance DuckDB server that replicates data from MySQL using **Sequential Appender architecture** with ACID transactions for guaranteed data integrity and **5-10x faster query performance**.

## 📦 Monorepo Structure

This project uses pnpm workspaces to manage multiple packages:

- **`packages/server`** - DuckDB server with MySQL replication (`@chittihq/duckling-server`)
- **`packages/frontend`** - Nuxt 4 web dashboard (`@chittihq/duckling-frontend`)
- **`packages/sdk`** - WebSocket SDK for DuckDB queries (`@chittihq/duckling`)
- **`packages/shared`** - Shared TypeScript types and constants (`@chittihq/duckling-shared`)

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

## Architecture

```
MySQL (Source) → Sequential Appender → DuckDB Native Storage → API Clients
                        ↓                      ↓
                  BEGIN TRANSACTION      Columnar Format
                  INSERT sequentially     (Compressed)
                  COMMIT / ROLLBACK      Watermark Tracking
                        ↓
                 Atomic & ACID
                 No Duplicates
                 Data Integrity

Storage Structure:
data/
└── duckling.db  # Single DuckDB file (persistent, columnar)
```

## Performance Comparison

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Query Speed** | 2-5 seconds | 200-500ms | **5-10x faster** |
| **Sync Performance** | 30min full | 5min incremental | **6x faster** |

## Architecture Benefits

| Feature | Sequential Appender | Previous Approach |
|---------|-------------------|-------------------|
| **Data Integrity** | ✅ ACID guaranteed | ❌ Partial writes possible |
| **Duplicates** | ✅ None (PK constraints) | ❌ Possible in append mode |
| **Missing Records** | ✅ None (transactions) | ❌ Possible on failure |
| **Storage Layers** | ✅ One (DuckDB) | ❌ Two (Parquet + Views) |
| **Restart Time** | ✅ Instant | ❌ View recreation needed |
| **Code Complexity** | ✅ ~800 lines | ❌ ~2800+ lines |

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

## Security Configuration (REQUIRED)

**⚠️ IMPORTANT: You MUST configure these security settings before deploying to production!**

### Required Security Settings

1. **Set Strong Admin Credentials**
   ```bash
   # In your .env file:
   ADMIN_USERNAME=your-admin-username
   ADMIN_PASSWORD=your-strong-password-here
   ```

   **WARNING:** Never use default credentials like `admin/admin` in production!

2. **Generate Strong Session Secret**
   ```bash
   # Generate a secure random session secret:
   SESSION_SECRET=$(openssl rand -hex 32)

   # Add to .env file:
   SESSION_SECRET=<generated-value>
   ```

3. **Set API Key for Programmatic Access**
   ```bash
   # Generate a secure API key:
   DUCKLING_API_KEY=$(openssl rand -hex 32)

   # Or use your own secure random string
   # Add to .env file:
   DUCKLING_API_KEY=<your-secure-api-key>
   ```

### Security Best Practices

- **Never commit `.env` files** to version control (already in `.gitignore`)
- **Use strong, unique passwords** for admin accounts
- **Rotate API keys regularly** in production environments
- **Enable HTTPS** when exposing the service externally
- **Restrict network access** using firewall rules or VPC configurations
- **Monitor authentication logs** for suspicious activity

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

## API Endpoints

### Health & Status
- `GET /health` - Health check with architecture info
- `GET /status` - System status with table counts and uptime
- `GET /metrics` - Sync performance metrics and history

### Synchronization
- `POST /sync/full` - Run full synchronization (atomic)
- `POST /sync/incremental` - Run watermark-based incremental sync
- `POST /sync/table/:tableName` - Sync specific table
- `GET /sync/status` - Sync status with watermark info
- `GET /sync/validate` - Validate data integrity (MySQL vs DuckDB counts)
- `DELETE /sync/clear-all` - Clear all data and reinitialize

### Automation & Recovery
- `GET /automation/status` - Get automation service status
- `POST /automation/start` - Start automation service
- `POST /automation/stop` - Stop automation service
- `POST /automation/backup` - Trigger manual backup
- `POST /automation/restore` - Restore from latest backup
- `POST /automation/cleanup` - Trigger manual cleanup

### Data Access
- `GET /tables` - List all replicated tables
- `GET /tables/:name/schema` - Get table schema
- `GET /tables/:name/data` - Get table data
- `GET /tables/:name/count` - Get row count
- `GET /tables/counts/all` - Get all table counts in parallel
- `POST /query` - Execute SQL queries on DuckDB

## Query Performance Examples

### Star Schema Joins

```sql
-- Columnar processing with DuckDB optimizations
SELECT
    c.region,
    date_trunc('day', o.order_date) AS day,
    SUM(o.amount) AS revenue
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
WHERE o.order_date >= CURRENT_DATE - INTERVAL 7 DAY
GROUP BY c.region, day
ORDER BY day DESC;

-- Performance: ~200ms (was 2-5s)
```

### Time-Range Queries

```sql
-- Efficient columnar filtering
SELECT COUNT(*), AVG(amount)
FROM orders
WHERE order_date BETWEEN '2024-01-15' AND '2024-01-16';

-- Performance: ~50ms (was 1-2s)
```

### Analytical Queries

```sql
-- Column-oriented processing
SELECT
    product_category,
    COUNT(*) as order_count,
    SUM(amount) as total_revenue
FROM orders
GROUP BY product_category;

-- Only scans needed columns, compressed data
```

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

## Monitoring & Operations

### Health Monitoring

```bash
# Check system health
curl http://localhost:3000/health

# Get system status
curl http://localhost:3000/status

# Get sync metrics
curl http://localhost:3000/metrics
```

### Sync Operations

```bash
# Run full sync
curl -X POST http://localhost:3000/sync/full

# Run incremental sync
curl -X POST http://localhost:3000/sync/incremental

# Sync specific table
curl -X POST http://localhost:3000/sync/table/orders

# Validate data integrity
curl http://localhost:3000/sync/validate
```

### Sync Status Response

```json
{
  "tablesProcessed": 181,
  "totalRecords": 1234567,
  "successCount": 181,
  "errorCount": 0,
  "watermarks": [
    {
      "table": "orders",
      "lastProcessedId": 98765,
      "lastProcessedTimestamp": "2024-01-20T10:30:00Z"
    }
  ],
  "recentLogs": [
    {
      "table": "orders",
      "syncType": "incremental",
      "recordsProcessed": 1523,
      "duration": "2.3s",
      "status": "success"
    }
  ],
  "architecture": "sequential-appender"
}
```

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

## Docker Deployment

### Monorepo Multi-Stage Dockerfile

The project uses multi-stage Docker builds for optimal image sizes:

- **`Dockerfile`** - Production build with optimized layers for server and frontend
- **`Dockerfile.dev`** - Development build with all dev dependencies

### docker-compose.yml

```yaml
version: '3.8'

services:
  duckdb-server:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3001:3000"
    environment:
      - MYSQL_CONNECTION_STRING=mysql://root:password@mysql:3306/myapp
      - BATCH_SIZE=10000
      - SYNC_INTERVAL_MINUTES=15
    volumes:
      - ./packages/server/src:/app/packages/server/src:ro
      - ./packages/server/public:/app/packages/server/public:ro
      - ./packages/shared:/app/packages/shared:ro
      - ./data:/app/data
      - ./logs:/app/logs
    depends_on:
      - mysql
    restart: unless-stopped
    command: pnpm dev:server

  duckdb-frontend:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3001"
    volumes:
      - ./packages/frontend:/app/packages/frontend:ro
      - ./packages/shared:/app/packages/shared:ro
      - ./packages/sdk:/app/packages/sdk:ro
    depends_on:
      - duckdb-server
    restart: unless-stopped
    command: pnpm dev:frontend

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: password
      MYSQL_DATABASE: myapp
    volumes:
      - mysql_data:/var/lib/mysql
    restart: unless-stopped

volumes:
  mysql_data:
  node_modules:
```

### Production Build

```bash
# Build production images
docker build --target server -t duckling-server .
docker build --target frontend -t duckling-frontend .

# Run production containers
docker run -d -p 3000:3000 duckling-server
docker run -d -p 3001:3001 duckling-frontend
```

## Security

- API key authentication for programmatic access
- Session-based authentication for web dashboard
- Input validation and SQL injection prevention
- Rate limiting on API endpoints
- Comprehensive audit logging in `sync_log` table
- Secure file permissions for DuckDB database file

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
- See `MIGRATION_SUMMARY.md` for migration guidance