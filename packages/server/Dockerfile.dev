FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package*.json ./
COPY pnpm-lock.yaml* ./

# Install all dependencies (including dev dependencies)
RUN pnpm install && pnpm rebuild

# Copy source code (this will be overridden by volume mounts in dev)
COPY src ./src
COPY public ./public
COPY tsconfig.json ./

# Create necessary directories
RUN mkdir -p /var/lib/duckdb /app/logs /app/data

EXPOSE 3000

# Default command for development (will be overridden by docker-compose)
CMD ["pnpm", "run", "dev"]