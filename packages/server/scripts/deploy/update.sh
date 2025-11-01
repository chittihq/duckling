#!/bin/bash

set -e

# Must be run from project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVICE_NAME="duckdb-server"
INSTALL_DIR="/opt/duckdb-server"
BACKUP_DIR="/var/backups/duckdb"
DATA_DIR="/var/lib/duckdb"

echo "Updating DuckDB Server..."
echo "Project root: $PROJECT_ROOT"

# Ensure we're in project root
cd "$PROJECT_ROOT"

# Create backup
echo "Creating backup..."
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
sudo cp -r "$INSTALL_DIR" "$BACKUP_DIR/duckdb-server_$DATE"
sudo cp "$DATA_DIR/duckling.db" "$BACKUP_DIR/duckling_$DATE.db" 2>/dev/null || echo "No existing database found"

# Stop service
echo "Stopping service..."
sudo systemctl stop "$SERVICE_NAME"

# Update application
echo "Updating application files..."
sudo cp -r dist package.json "$INSTALL_DIR/"
sudo cp pnpm-lock.yaml "$INSTALL_DIR/" 2>/dev/null || echo "No pnpm-lock.yaml found"

# Update service file if changed
if [ -f "$PROJECT_ROOT/scripts/deploy/duckdb-server.service" ]; then
    echo "Updating service file..."
    sudo cp "$PROJECT_ROOT/scripts/deploy/duckdb-server.service" /etc/systemd/system/
    sudo systemctl daemon-reload
fi

# Update dependencies
echo "Updating dependencies..."
cd "$INSTALL_DIR"
sudo pnpm install --prod

# Set correct permissions
echo "Setting permissions..."
sudo chown -R duckdb:duckdb "$INSTALL_DIR"
sudo chmod -R 755 "$INSTALL_DIR"

# Start service
echo "Starting service..."
sudo systemctl start "$SERVICE_NAME"

# Wait for service to be ready
echo "Waiting for service to be ready..."
sleep 5

# Check health
if curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo "Update completed successfully!"
    echo "Service is running and healthy."
else
    echo "Warning: Service may not be responding correctly."
    echo "Check service status: sudo systemctl status $SERVICE_NAME"
fi

echo ""
echo "To check logs:"
echo "  sudo journalctl -u $SERVICE_NAME -f"