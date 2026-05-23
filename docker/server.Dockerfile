# Duckling Server (ClickHouse + PeerDB CDC). Dev/dev-with-bind-mount image.
FROM node:20-slim

WORKDIR /app

# Native module build deps.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.0.0

# Workspace manifests first for cache-friendly layering.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/frontend/package.json ./packages/frontend/

RUN pnpm install && pnpm rebuild

# Copy source. The image stays self-contained: if compose runs without bind
# mounts (e.g. remote Docker contexts, Docker Desktop file-sync issues), the
# in-image source is what gets used. Bind mounts in docker-compose.yml are
# overlays for hot-reload during local dev only.
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/sdk ./packages/sdk

# Build the server inside the image so `docker exec ... node packages/server/dist/cli.js`
# and the production-mode `npm start` work without any host-side build step.
RUN pnpm --filter @chittihq/duckling-shared build && pnpm --filter @chittihq/duckling-server build

RUN mkdir -p /app/logs /app/data

# Heap headroom for full-sync batches; expose-gc lets the server free between flushes.
ENV NODE_OPTIONS="--max-old-space-size=4096 --expose-gc"

EXPOSE 3000

# Default to nodemon dev mode (hot reload from bind-mounted src when present;
# falls back to image-resident src otherwise).
CMD ["pnpm", "dev:server"]
