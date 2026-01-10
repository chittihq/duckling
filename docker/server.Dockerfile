# DuckDB Server - Development Dockerfile
FROM node:20-slim

WORKDIR /app

# Install system dependencies required for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files for all packages (for proper dependency resolution)
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies
RUN pnpm install && pnpm rebuild

# Copy source code for all packages
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/sdk ./packages/sdk
COPY packages/frontend ./packages/frontend

# Create necessary directories
RUN mkdir -p /var/lib/duckdb /app/logs /app/data

# Set Node.js options for memory optimization
# --max-old-space-size=4096: Increase heap size to 4GB to handle large table syncs
# --expose-gc: Enable manual garbage collection for memory cleanup after flushes
ENV NODE_OPTIONS="--max-old-space-size=4096 --expose-gc"

# Expose server port
EXPOSE 3000

# Default command - runs the server in development mode with hot reload
CMD ["pnpm", "dev:server"]
