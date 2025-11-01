FROM node:20-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy all package.json files for dependency resolution
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/frontend/package.json ./packages/frontend/

# Install dependencies
RUN pnpm install --frozen-lockfile && pnpm rebuild

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/sdk ./packages/sdk
COPY packages/frontend ./packages/frontend

# Build packages
RUN pnpm build:shared && \
    pnpm build:sdk && \
    pnpm build:server && \
    pnpm build:frontend

# Create necessary directories
RUN mkdir -p /var/lib/duckdb /app/data /app/logs

# Production stage - Server
FROM node:20-slim AS server

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.0.0

# Copy built artifacts and dependencies
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./

# Create data directories
RUN mkdir -p /var/lib/duckdb /app/data /app/logs

EXPOSE 3000

CMD ["pnpm", "start:server"]