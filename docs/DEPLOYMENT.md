# Deployment Guide

> ⚠️ **Legacy doc (DuckDB era).** Duckling is ClickHouse-backed now. The Dockerfile, compose layout, and image strategy have all changed. Current production deployment guidance lives in `README.md` ("Quick start" + "Development" sections) and `CLAUDE.md` ("Docker Development" section). The current Dockerfile is `docker/server.Dockerfile`. The PeerDB stack is in `docker-compose.peerdb.yml`.

---

This guide covers deployment options for Duckling DuckDB Server.

## Docker Deployment

### Monorepo Multi-Stage Dockerfile

The project uses multi-stage Docker builds for optimal image sizes:

- **`Dockerfile`** - Production build with optimized layers for server and frontend
- **`Dockerfile.dev`** - Development build with all dev dependencies

### docker-compose.yml

Create a `.env` file in the project root with real values for `MYSQL_CONNECTION_STRING` and `MYSQL_ROOT_PASSWORD` before running this compose setup.

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
      - MYSQL_CONNECTION_STRING=${MYSQL_CONNECTION_STRING}
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
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
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

### Security Features

- API key authentication for programmatic access
- Session-based authentication for web dashboard
- Input validation and SQL injection prevention
- Rate limiting on API endpoints
- Comprehensive audit logging in `sync_log` table
- Secure file permissions for DuckDB database file

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
