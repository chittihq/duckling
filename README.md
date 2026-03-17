# Duckling

![Duckling Banner](docs/images/banner.jpeg)

DuckDB server that replicates your MySQL data. Columnar storage makes analytical queries 100-13,000x faster depending on query shape. Writes are ACID, no partial syncs, no duplicates.

## Benchmarks (20M rows)

Real numbers from the [benchmark suite](benchmark/):

| Query | MySQL | DuckDB | Speedup |
|-------|-------|--------|---------|
| Full table count | 4,258 ms | 4 ms | 1,064x |
| Filtered count | 1,475 ms | 20 ms | 73x |
| Group by status | 433,259 ms | 32 ms | 13,539x |
| Region x status breakdown | 16,685 ms | 112 ms | 148x |
| Monthly revenue (2023) | 7,536 ms | 30 ms | 251x |
| Regional analytics | 446,038 ms | 394 ms | 1,132x |
| **Total** | **909,251 ms** | **592 ms** | **1,535x** |

```bash
cd benchmark
./run.sh                        # 20M rows
BENCHMARK_SCALE=0.01 ./run.sh   # 200K rows (quick smoke test)
```

## What it does

Replicates MySQL tables into DuckDB with ACID transactions. Incremental sync only fetches what changed since the last watermark. If you need sub-second replication, there's optional CDC through the MySQL binlog.

Query it over REST, WebSocket, or the MySQL wire protocol on port 3307 (so any MySQL client just works). There's a Nuxt 4 dashboard too. Runs on a $20/month droplet.

| Feature | |
|---------|---|
| Data integrity | ACID transactions, primary key constraints |
| Storage | Single DuckDB file per database, columnar, compressed |
| Sync modes | Full, incremental (watermark), CDC (binlog) |
| Query access | REST API, WebSocket SDK, native MySQL protocol (port 3307) |
| Multi-database | Multiple MySQL sources replicated independently |
| Schema changes | Additive column evolution, zero downtime |

## How sync works

| Mechanism | Trigger | When to use |
|-----------|---------|-------------|
| Full sync | Manual or first run | Initial load, disaster recovery |
| Incremental | Every 15 min (automatic) | Routine catch-up |
| CDC | MySQL binlog stream | Sub-second replication (opt-in) |

Full sync uses Appender-based staging swaps, while incremental sync stages watermark deltas into DuckDB and merges them transactionally by primary key. Watermarks track the last processed ID/timestamp per table. Tables sync in parallel with per-table locking, so a slow table doesn't block the rest.

CDC streams binlog events via [ZongJi](https://github.com/vlasky/zongji), processing inserts, updates, and deletes in order. Binlog position is checkpointed for resume after restarts. Enable with `CDC_ENABLED=true`. It can run alongside scheduled syncs.

Row sanitization (type conversion, null handling, date formatting) runs in a worker thread pool, so large syncs don't block the main thread.

## MySQL wire protocol

Port 3307 runs a MySQL wire protocol server. Connect with any MySQL client:

```bash
mysql -h 127.0.0.1 -P 3307 -u duckling -p
```

If it speaks MySQL, it works. Queries hit DuckDB under the hood.

| Variable | Default | |
|----------|---------|---|
| `MYSQL_PROTOCOL_ENABLED` | `true` | Turn the protocol server on/off |
| `MYSQL_PROTOCOL_PORT` | `3307` | TCP port |
| `MYSQL_PROTOCOL_USER` | `duckling` | Login username |
| `MYSQL_PROTOCOL_PASSWORD` | uses `DUCKLING_API_KEY` | Login password |
| `MYSQL_PROTOCOL_MAX_CONNECTIONS` | `50` | Max concurrent connections |

## Query governor

Caps concurrent DuckDB queries and kills long-running ones. Sync and CDC get priority so replication doesn't stall when someone fires off a heavy report.

| Variable | Default | |
|----------|---------|---|
| `MAX_CONCURRENT_QUERIES` | `10` | Concurrent query cap |
| `QUERY_TIMEOUT_MS` | `30000` | Per-query timeout |
| `QUERY_QUEUE_MAX` | `50` | Queue depth before 503 |

## Read replicas

Keeps a read-only copy of the DuckDB file for API queries while sync and CDC write to the primary. The replica is a periodic snapshot, so queries lag behind by at most `REPLICA_REFRESH_INTERVAL` seconds. Off by default.

| Variable | Default | |
|----------|---------|---|
| `READ_REPLICA_ENABLED` | `false` | Off by default |
| `REPLICA_REFRESH_INTERVAL` | `300` | Seconds between snapshots |

## Backups

Local backups run daily by default. S3 backups are opt-in with optional client-side AES-256 encryption.

| Variable | Default | |
|----------|---------|---|
| `AUTO_BACKUP` | `true` | Scheduled local backups |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between backups |
| `BACKUP_RETENTION_DAYS` | `7` | Days to keep old backups |

### Encryption

| Mode | Key holder | |
|------|-----------|---|
| `none` | -- | No encryption |
| `sse-s3` | AWS | At-rest encryption |
| `sse-kms` | AWS KMS | At-rest + CloudTrail audit |
| `client-aes256` | you | Encrypted before upload, bucket leak safe |

Use `client-aes256` for production. Streams AES-256-CTR on upload, verifies HMAC-SHA256 on restore.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

R2, B2, Spaces, and MinIO all work via the `endpoint` field. The `/backups` dashboard page handles config, triggers, history, and restores.

## Observability

The `/observe` dashboard page shows CPU, memory, event loop latency, active queries, and query pattern stats (which queries run most, slowest, etc.). Samples every 30 seconds, keeps 30 minutes of history.

Endpoints: `GET /api/metrics/system`, `GET /api/metrics/queries`.

## Why DuckDB and not X?

**vs MariaDB ColumnStore:** DuckDB is embedded (no separate server), runs on 4GB RAM instead of 128GB, handles empty strings correctly, and costs $20/month instead of $500+. If you have 100TB+ of data, ColumnStore might make more sense. We don't.

**vs ClickHouse:** No ZooKeeper, no cluster management, no JOIN limits, actual ACID transactions. ClickHouse wins when you're ingesting 100K+ rows/sec into 10B+ row tables and have ops people to babysit it.

## Quick start

### Docker

```bash
git clone <repository>
cd duckling
pnpm install && pnpm run build

docker-compose up -d

curl http://localhost:3001/health  # Server
curl http://localhost:3000         # Frontend
```

### Manual

```bash
pnpm install
pnpm run build
pnpm run start:server
# In another terminal:
pnpm run start:frontend
```

### Development

```bash
pnpm run dev                # Both server + frontend, hot reload
pnpm run dev:server         # Server only
pnpm run dev:frontend       # Frontend only
```

## Configuration

Copy `.env.example` to `.env`:

```bash
MYSQL_CONNECTION_STRING=mysql://user:password@localhost:3306/database
DUCKDB_PATH=data/duckling.db
DUCKLING_API_KEY=your-secret-key

SYNC_INTERVAL_MINUTES=15
BATCH_SIZE=10000
ENABLE_INCREMENTAL_SYNC=true
AUTO_START_SYNC=false
EXCLUDED_TABLES=temp_table,cache_table
```

| Variable | Default | What it does |
|----------|---------|-------------|
| `MYSQL_CONNECTION_STRING` | required | MySQL connection string |
| `DUCKDB_PATH` | `data/duckling.db` | Where the DuckDB file lives |
| `DUCKLING_API_KEY` | required | API key for auth (also used as MySQL protocol password) |
| `BATCH_SIZE` | `10000` | Rows per batch during sync |
| `SYNC_INTERVAL_MINUTES` | `15` | How often incremental sync runs |
| `ENABLE_INCREMENTAL_SYNC` | `true` | Use watermark-based incremental sync |
| `AUTO_START_SYNC` | `true` | Start syncing when the server boots |
| `EXCLUDED_TABLES` | none | Comma-separated tables to skip |
| `CDC_ENABLED` | `false` | Enable binlog-based CDC |
| `MAX_RETRIES` | `3` | Retry attempts on failure |
| `WORKER_THREADS` | `0` (auto) | Worker threads for row sanitization (0 = CPU count - 1) |

## Tuning

`BATCH_SIZE` defaults to 10,000 rows. For tables under 100K rows, 5,000 works. Over 1M, try 20,000.

`SYNC_INTERVAL_MINUTES` defaults to 15. Busy databases might want 5-10 min, quiet ones can do 30-60.

`WORKER_THREADS` controls how many threads handle row sanitization (type conversion, null coercion, date formatting) during sync. Defaults to CPU count minus one. The main thread stays free for DuckDB reads and writes.

For queries, selecting only the columns you need helps most. DuckDB scans columns, not rows, so fewer columns = less data read.

## Type support

All standard MySQL 8 types work, including JSON (mapped to DuckDB's native JSON type), ENUM, BOOLEAN, DATE, and full UTF-8 4-byte characters (emoji). Spatial/geometry types (`POINT`, `POLYGON`, `GEOMETRY`, etc.) do not work and fall through to `VARCHAR`. See [TYPES.md](TYPES.md) for the full mapping and test coverage.

## Testing

7 integration test suites covering full sync, incremental insert/update/delete, idempotency, CDC, and type fidelity across 27 MySQL types:

```bash
cd tests/integration
./run.sh
```

## More docs

- [API.md](./API.md) -- REST endpoints, WebSocket SDK, query examples
- [CLI.md](CLI.md) -- CLI commands
- [TYPES.md](TYPES.md) -- Type mapping, known limitations, integration test details
- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) -- Production deployment, security, backups

## Contributing

Fork the repo, make a branch, open a PR. Add tests for new functionality.

## License

MIT. See LICENSE file.
