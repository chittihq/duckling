# ============================================
# Duckling Production Dockerfile (ClickHouse)
# Single container that builds the Nuxt frontend and serves it from the API
# server (API + dashboard on one port).
#
# The analytical store is ClickHouse, reached over CLICKHOUSE_URL — run it as a
# SEPARATE service (see docker-compose.yml) and give THAT service the persistent
# volume at /var/lib/clickhouse. This container's /app/data holds only
# databases.json (config) + session/log state; the replicated data lives in
# ClickHouse, not here. If /app/data is lost you only lose config; the data
# re-syncs from the MySQL source of truth.
# ============================================

# Stage 1: Build all packages
FROM node:20-slim AS builder

WORKDIR /app

# Build toolchain for any transitive native addons. Discarded in the final
# image via multi-stage. (No DuckDB/sqlite anymore — the ClickHouse client is
# pure-JS over HTTP.)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Copy all package.json files for dependency resolution. The frontend depends on
# the sdk (@chittihq/duckling) and shared, so both must be present.
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/frontend/package.json ./packages/frontend/

# Install all dependencies (hoisted for TypeScript resolution)
RUN pnpm install --frozen-lockfile --shamefully-hoist && pnpm rebuild

# Copy all source code
COPY packages/shared ./packages/shared
COPY packages/sdk ./packages/sdk
COPY packages/server ./packages/server
COPY packages/frontend ./packages/frontend

# Build in dependency order: shared -> sdk -> server, then the frontend
# (which imports the sdk + shared at build time).
RUN pnpm build:shared && \
    pnpm build:sdk && \
    pnpm build:server && \
    pnpm build:frontend

# Stage 2: Production runtime - single executable
FROM node:20-slim AS production

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# The server depends only on the shared package at runtime; the frontend is
# served as pre-built static files, so it and the sdk are not needed here.
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install production dependencies only (no devDependencies, hoisted).
RUN pnpm install --prod --frozen-lockfile --shamefully-hoist

# Copy built artifacts from the builder stage.
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/

# Serve the frontend static build from the server's public directory.
RUN rm -rf ./packages/server/public
COPY --from=builder /app/packages/frontend/.output/public ./packages/server/public

# Config + logs live here (databases.json). NOT the analytical data — that is in
# ClickHouse. Back up /app/data to preserve database configs across redeploys.
RUN mkdir -p /app/data /app/logs

# Production environment
ENV NODE_ENV=production

# Heap headroom for large full-sync batches; expose-gc lets the server free
# memory between flushes.
ENV NODE_OPTIONS="--max-old-space-size=8192 --expose-gc"

# Serves both the API and the frontend
EXPOSE 3000

CMD ["pnpm", "start:server"]
