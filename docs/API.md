# Duckling API Reference

Complete API documentation for the Duckling DuckDB Server.

## Authentication

All API endpoints require authentication via one of:
- **API Key**: `Authorization: Bearer <DUCKLING_API_KEY>` header
- **Session**: Cookie-based auth via `/api/login` (for web dashboard)

## Base URL

- Development: `http://localhost:3001`
- Docker internal: `http://duckdb-server:3001`

## Multi-Database Support

All data endpoints accept the `?db={database_id}` query parameter to specify which database to operate on. If omitted, defaults to `default` database.

---

## Health & Status

### GET /health
Health check with architecture info.

```bash
curl http://localhost:3001/health
```

**Response:**
```json
{
  "status": "healthy",
  "architecture": "sequential-appender",
  "duckdb": "connected",
  "mysql": "connected"
}
```

### GET /status
System status with table counts and uptime.

```bash
curl http://localhost:3001/status
```

### GET /metrics
Sync performance metrics and history.

```bash
curl http://localhost:3001/metrics
```

---

## Synchronization

### POST /sync/full
Run full synchronization (atomic).

```bash
curl -X POST http://localhost:3001/sync/full \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### POST /sync/incremental
Run watermark-based incremental sync.

```bash
curl -X POST http://localhost:3001/sync/incremental \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### POST /sync/table/:tableName
Sync specific table.

```bash
curl -X POST http://localhost:3001/sync/table/orders \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### GET /sync/status
Sync status with watermark info.

```bash
curl http://localhost:3001/sync/status \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

**Response:**
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

### GET /sync/validate
Validate data integrity (MySQL vs DuckDB counts).

```bash
curl http://localhost:3001/sync/validate \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### DELETE /sync/clear-all
Clear all data and reinitialize.

```bash
curl -X DELETE http://localhost:3001/sync/clear-all \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

---

## Automation & Recovery

### GET /automation/status
Get automation service status.

```bash
curl http://localhost:3001/automation/status \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### POST /automation/start
Start automation service.

### POST /automation/stop
Stop automation service.

### POST /automation/backup
Trigger manual backup.

### POST /automation/restore
Restore from latest backup.

### POST /automation/cleanup
Trigger manual cleanup.

---

## Data Access

### GET /tables
List all replicated tables.

```bash
curl http://localhost:3001/tables \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### GET /tables/:name/schema
Get table schema.

```bash
curl http://localhost:3001/tables/orders/schema \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### GET /tables/:name/data
Get table data with pagination.

```bash
curl "http://localhost:3001/tables/orders/data?limit=100&offset=0" \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### GET /tables/:name/count
Get row count.

```bash
curl http://localhost:3001/tables/orders/count \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### GET /tables/counts/all
Get all table counts in parallel.

### POST /query
Execute SQL queries on DuckDB.

```bash
curl -X POST http://localhost:3001/query \
  -H "Authorization: Bearer $DUCKLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM orders LIMIT 10"}'
```

**Request Body:**
```json
{
  "sql": "SELECT * FROM orders WHERE order_date >= '2024-01-01' LIMIT 100"
}
```

**Response:**
```json
{
  "success": true,
  "result": [...],
  "rowCount": 100,
  "duration": 15
}
```

---

## Query Examples

### Star Schema Joins

```sql
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
SELECT COUNT(*), AVG(amount)
FROM orders
WHERE order_date BETWEEN '2024-01-15' AND '2024-01-16';

-- Performance: ~50ms (was 1-2s)
```

### Analytical Queries

```sql
SELECT
    product_category,
    COUNT(*) as order_count,
    SUM(amount) as total_revenue
FROM orders
GROUP BY product_category;

-- Only scans needed columns, compressed data
```

### Window Functions

```sql
SELECT
    refId, name, email,
    ROW_NUMBER() OVER (PARTITION BY boardId ORDER BY createdAt) as rank
FROM User;
```

### Time-Series Analytics

```sql
SELECT
    DATE_TRUNC('day', createdAt) as date,
    COUNT(*) as daily_signups
FROM User
WHERE createdAt >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY date
ORDER BY date;
```

---

## Database Management

### GET /api/databases
List all configured databases.

```bash
curl http://localhost:3001/api/databases \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### POST /api/databases
Add new database configuration.

```bash
curl -X POST http://localhost:3001/api/databases \
  -H "Authorization: Bearer $DUCKLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Database",
    "mysqlConnectionString": "mysql://...",
    "duckdbPath": "data/mydb.db"
  }'
```

### PUT /api/databases/:id
Update database configuration.

### DELETE /api/databases/:id
Remove database configuration.

### POST /api/databases/:id/test
Test database connection.

---

## Validation

### POST /api/validation/table-details
Get detailed validation info for a table.

```bash
curl -X POST http://localhost:3001/api/validation/table-details \
  -H "Authorization: Bearer $DUCKLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tableName": "orders", "skipMySQLCount": false}'
```

**Request Body:**
```json
{
  "tableName": "orders",
  "skipMySQLCount": true  // Skip slow MySQL COUNT(*) for faster validation
}
```

**Response:**
```json
{
  "duckdb": {
    "exists": true,
    "columnCount": 10,
    "recordCount": 50000,
    "columns": ["id", "order_date", "amount", ...]
  },
  "mysql": {
    "exists": true,
    "columnCount": 10,
    "recordCount": 50000,
    "columns": ["id", "order_date", "amount", ...]
  },
  "columnsMatch": true,
  "missingColumns": [],
  "extraColumns": [],
  "errorType": null,
  "errorMessage": null,
  "mysqlCountSkipped": false
}
```

---

## WebSocket API

For high-performance real-time queries, use the WebSocket SDK.

**Endpoint:** `ws://localhost:3001/ws`

See [SDK Documentation](./packages/sdk/README.md) for usage.

### Quick Example

```typescript
import { DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY
});

const users = await client.query('SELECT * FROM User LIMIT 10');
client.close();
```

### Performance

| Method | Latency | Throughput |
|--------|---------|------------|
| HTTP API | 50-100ms | ~1,000 queries/sec |
| WebSocket | 5-15ms | 10,000+ queries/sec |

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Error message here",
  "code": "ERROR_CODE"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid auth |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |
