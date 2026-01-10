# ============================================
# Duckling Production Dockerfile
# Single container that builds frontend and serves it from the server
# ============================================

# Stage 1: Build all packages
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Copy all package.json files for dependency resolution
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/frontend/package.json ./packages/frontend/

# Install all dependencies with frozen lockfile (with hoisting for TypeScript resolution)
RUN pnpm install --frozen-lockfile --shamefully-hoist && pnpm rebuild

# Copy all source code
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/frontend ./packages/frontend

# Build all packages in correct order
RUN pnpm build:shared && \
    pnpm build:server && \
    pnpm build:frontend

# Stage 2: Production runtime - Single executable
FROM node:20-slim AS production

WORKDIR /app

# Install only runtime system dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10.0.0

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Copy package.json files for all packages
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install production dependencies only (no devDependencies, with hoisting)
RUN pnpm install --prod --frozen-lockfile --shamefully-hoist

# Copy built artifacts from builder stage
# Shared package
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Server package (built)
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/

# Copy frontend build output to server's public directory
# This allows the server to serve the frontend static files
RUN rm -rf ./packages/server/public
COPY --from=builder /app/packages/frontend/.output/public ./packages/server/public

# Create necessary data directories
RUN mkdir -p /var/lib/duckdb /app/data /app/logs

# Set production environment
ENV NODE_ENV=production

# Set Node.js heap size to 8GB for large sync operations
# --max-old-space-size=8192: 8GB heap for production workloads
# --expose-gc: Enable manual garbage collection for memory cleanup
ENV NODE_OPTIONS="--max-old-space-size=8192 --expose-gc"

# Expose server port (serves both API + Frontend)
EXPOSE 3000

# Run the server - it serves both the API and the frontend
CMD ["pnpm", "start:server"]