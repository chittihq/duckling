# Deployment Guide

This guide covers deployment options for Duckling DuckDB Server.

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

### Security Configuration

See the [Security Configuration](../README.md#security-configuration-required) section in README.md for required security settings before deploying to production.

## Environment Variables

For a complete list of environment variables, see the [Configuration](../README.md#configuration) section in README.md.

### Production Recommendations

| Variable | Production Value | Notes |
|----------|------------------|-------|
| `NODE_ENV` | `production` | Enables production optimizations |
| `BATCH_SIZE` | `10000-20000` | Larger batches for faster sync |
| `SYNC_INTERVAL_MINUTES` | `15-30` | Balance freshness vs load |
| `MAX_RETRIES` | `3-5` | Handle transient failures |
| `AUTO_BACKUP` | `true` | Enable daily backups |
| `BACKUP_RETENTION_DAYS` | `7-30` | Based on compliance needs |

## Health Checks

Use the health endpoint for load balancer and orchestration:

```bash
# Health check endpoint
curl http://localhost:3001/health

# Expected response
{
  "status": "healthy",
  "architecture": "sequential-appender",
  "duckdb": "connected",
  "mysql": "connected"
}
```

## Monitoring

- Structured logs for external log aggregation (stdout/stderr)
- Health check endpoints for load balancer integration
- Sync metrics available at `/metrics` endpoint
- Sync logs available at `/api/sync-logs`

### Log Aggregation

Logs are written to stdout in JSON format for easy integration with:
- ELK Stack (Elasticsearch, Logstash, Kibana)
- Datadog
- CloudWatch
- Splunk

## Backup & Recovery

Automated backups are enabled by default:

- **Frequency**: Every 24 hours (`BACKUP_INTERVAL_HOURS=24`)
- **Retention**: 7 days (`BACKUP_RETENTION_DAYS=7`)
- **Location**: `data/backups/`

### Manual Backup

```bash
curl -X POST http://localhost:3001/automation/backup \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

### Restore

```bash
curl -X POST http://localhost:3001/automation/restore \
  -H "Authorization: Bearer $DUCKLING_API_KEY"
```

## Troubleshooting

### Common Issues

1. **Connection Refused**: Check if MySQL is accessible from the container
2. **Sync Failing**: Check `/api/sync-logs` for error details
3. **Slow Queries**: Verify DuckDB file isn't corrupted, check disk I/O
4. **Out of Memory**: Reduce `BATCH_SIZE` for large tables

### Debug Mode

Enable debug logging:

```bash
LOG_LEVEL=debug docker-compose up
```

### Container Logs

```bash
# Server logs
docker-compose logs -f duckdb-server

# Frontend logs
docker-compose logs -f duckdb-frontend
```
