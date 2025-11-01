# Deployment Scripts

SystemD-based deployment scripts for production Linux servers.

## Prerequisites

Before deploying:

1. **Build the application:**
   ```bash
   pnpm run build
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your production settings
   ```

3. **Linux server with:**
   - SystemD (Ubuntu 16.04+, Debian 8+, CentOS 7+, etc.)
   - Node.js 18+ installed (`/usr/bin/node`)
   - sudo access
   - curl (for health checks)

## Installation

From the **project root directory**, run:

```bash
./scripts/deploy/install.sh
```

This will:
- Create `duckdb` system user
- Install to `/opt/duckdb-server`
- Copy configuration to `/etc/duckdb-server/env`
- Install SystemD service
- Set up log rotation
- Create automated backup script (runs at 2 AM daily)
- Create health monitoring script (runs every 5 minutes)

### After Installation

```bash
# Start the service
sudo systemctl start duckdb-server

# Check status
sudo systemctl status duckdb-server

# View logs
sudo journalctl -u duckdb-server -f

# Test health endpoint
curl http://localhost:3000/health
```

## Updating

From the **project root directory** after building new version:

```bash
./scripts/deploy/update.sh
```

This will:
- Create backup of current installation
- Stop the service
- Update application files
- Update SystemD service if changed
- Reinstall dependencies
- Start the service
- Verify health

## Important Notes

### Running Location
**Always run these scripts from the project root directory**, not from `scripts/deploy/`.

```bash
# ✅ Correct
cd /path/to/duckling
./scripts/deploy/install.sh

# ❌ Wrong
cd /path/to/duckling/scripts/deploy
./install.sh
```

### Configuration
After installation, edit `/etc/duckdb-server/env` with your production settings:

```bash
sudo nano /etc/duckdb-server/env
```

Required settings:
- `MYSQL_CONNECTION_STRING` - Your MySQL connection
- `ADMIN_USERNAME` - Admin dashboard username
- `ADMIN_PASSWORD` - Strong password
- `SESSION_SECRET` - Generate with `openssl rand -hex 32`
- `DUCKLING_API_KEY` - Generate with `openssl rand -hex 32`

After changing configuration:
```bash
sudo systemctl restart duckdb-server
```

### Automated Tasks

The installation sets up:

1. **Daily backups** (2 AM)
   - Location: `/var/backups/duckdb/`
   - Retention: 7 days
   - Manual trigger: `/usr/local/bin/duckdb-backup.sh`

2. **Health monitoring** (every 5 minutes)
   - Auto-restarts on failure
   - Manual trigger: `/usr/local/bin/duckdb-monitor.sh`

3. **Log rotation** (daily)
   - Keeps 30 days of logs
   - Compresses old logs

### File Locations

- **Application:** `/opt/duckdb-server/`
- **Database:** `/var/lib/duckdb/duckling.db`
- **Configuration:** `/etc/duckdb-server/env`
- **Logs:** `/var/log/duckdb/` and `journalctl -u duckdb-server`
- **Backups:** `/var/backups/duckdb/`

### Uninstallation

```bash
# Stop and disable service
sudo systemctl stop duckdb-server
sudo systemctl disable duckdb-server

# Remove files
sudo rm /etc/systemd/system/duckdb-server.service
sudo rm -rf /opt/duckdb-server
sudo rm -rf /etc/duckdb-server
sudo rm -rf /var/log/duckdb
sudo rm /usr/local/bin/duckdb-backup.sh
sudo rm /usr/local/bin/duckdb-monitor.sh
sudo rm /etc/cron.d/duckdb-backup
sudo rm /etc/cron.d/duckdb-monitor
sudo rm /etc/logrotate.d/duckdb-server

# Optionally remove data and backups
sudo rm -rf /var/lib/duckdb
sudo rm -rf /var/backups/duckdb

# Reload systemd
sudo systemctl daemon-reload

# Optionally remove user
sudo userdel duckdb
```

## Troubleshooting

### Service won't start

```bash
# Check service status
sudo systemctl status duckdb-server

# Check detailed logs
sudo journalctl -u duckdb-server -n 100 --no-pager

# Verify configuration
sudo cat /etc/duckdb-server/env

# Check file permissions
ls -la /opt/duckdb-server/
ls -la /var/lib/duckdb/
```

### Build directory missing

```bash
# Error: dist/ directory not found
cd /path/to/duckling
pnpm run build
./scripts/deploy/install.sh
```

### Permission denied

Make sure scripts are executable:
```bash
chmod +x scripts/deploy/*.sh
```

### Health check fails

```bash
# Check if service is running
sudo systemctl is-active duckdb-server

# Check what port it's listening on
sudo netstat -tlnp | grep node

# Test health endpoint
curl -v http://localhost:3000/health
```
