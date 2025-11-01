#!/bin/bash

set -e

# Must be run from project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Configuration
SERVICE_NAME="duckdb-server"
SERVICE_USER="duckdb"
SERVICE_GROUP="duckdb"
INSTALL_DIR="/opt/duckdb-server"
DATA_DIR="/var/lib/duckdb"
LOG_DIR="/var/log/duckdb"
CONFIG_DIR="/etc/duckdb-server"

echo "Installing DuckDB Server..."
echo "Project root: $PROJECT_ROOT"

# Ensure we're in project root
cd "$PROJECT_ROOT"

# Check prerequisites
if [ ! -d "dist" ]; then
    echo "Error: dist/ directory not found. Please run 'pnpm run build' first."
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "Warning: .env file not found. You'll need to create it manually in $CONFIG_DIR/env"
    echo "Copy .env.example and configure it with your settings."
fi

# Create user and group
if ! id -u "$SERVICE_USER" > /dev/null 2>&1; then
    echo "Creating user $SERVICE_USER..."
    sudo useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
fi

# Create directories
echo "Creating directories..."
sudo mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR" "$CONFIG_DIR"

# Copy application files
echo "Copying application files..."
sudo cp -r dist package.json "$INSTALL_DIR/"
sudo cp pnpm-lock.yaml "$INSTALL_DIR/" 2>/dev/null || echo "No pnpm-lock.yaml found"

# Copy .env if it exists
if [ -f ".env" ]; then
    sudo cp .env "$CONFIG_DIR/env"
else
    echo "Creating placeholder .env file. YOU MUST CONFIGURE THIS!"
    sudo cp .env.example "$CONFIG_DIR/env"
fi

# Install pnpm and dependencies
echo "Installing pnpm and dependencies..."
cd "$INSTALL_DIR"
sudo npm install -g pnpm
sudo pnpm install --prod

# Set permissions
echo "Setting permissions..."
sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
sudo chmod -R 755 "$INSTALL_DIR"
sudo chmod -R 750 "$DATA_DIR" "$LOG_DIR"
sudo chmod 640 "$CONFIG_DIR/env"

# Install systemd service
echo "Installing systemd service..."
sudo cp "$PROJECT_ROOT/scripts/deploy/duckdb-server.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

# Install logrotate configuration
echo "Installing logrotate configuration..."
sudo tee /etc/logrotate.d/duckdb-server > /dev/null <<EOF
$LOG_DIR/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0644 $SERVICE_USER $SERVICE_GROUP
    postrotate
        systemctl reload $SERVICE_NAME
    endscript
}
EOF

# Create backup script
echo "Creating backup script..."
sudo tee /usr/local/bin/duckdb-backup.sh > /dev/null <<EOF
#!/bin/bash
BACKUP_DIR="/var/backups/duckdb"
DATE=\$(date +%Y%m%d_%H%M%S)
mkdir -p "\$BACKUP_DIR"
cp "$DATA_DIR/duckling.db" "\$BACKUP_DIR/duckling_\$DATE.db"
find "\$BACKUP_DIR" -name "*.db" -mtime +7 -delete
EOF

sudo chmod +x /usr/local/bin/duckdb-backup.sh

# Create backup cron job
echo "Creating backup cron job..."
sudo tee /etc/cron.d/duckdb-backup > /dev/null <<EOF
0 2 * * * $SERVICE_USER /usr/local/bin/duckdb-backup.sh
EOF

# Create monitoring script
echo "Creating monitoring script..."
sudo tee /usr/local/bin/duckdb-monitor.sh > /dev/null <<EOF
#!/bin/bash
if ! systemctl is-active --quiet $SERVICE_NAME; then
    echo "DuckDB Server is not running, attempting to restart..."
    systemctl restart $SERVICE_NAME
fi

# Check if service is responding
if ! curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo "DuckDB Server health check failed, restarting..."
    systemctl restart $SERVICE_NAME
fi
EOF

sudo chmod +x /usr/local/bin/duckdb-monitor.sh

# Create monitoring cron job
echo "Creating monitoring cron job..."
sudo tee /etc/cron.d/duckdb-monitor > /dev/null <<EOF
*/5 * * * * root /usr/local/bin/duckdb-monitor.sh
EOF

echo "Installation completed successfully!"
echo ""
echo "To start the service:"
echo "  sudo systemctl start $SERVICE_NAME"
echo ""
echo "To check status:"
echo "  sudo systemctl status $SERVICE_NAME"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "To check health:"
echo "  curl http://localhost:3000/health"