# @chittihq/duckling-shared

Shared TypeScript types, constants, and utilities for the Duckling DuckDB Server monorepo.

## Installation

```bash
# Within the monorepo
pnpm add @chittihq/duckling-shared --workspace

# For external use (if published)
pnpm add @chittihq/duckling-shared
```

## Usage

```typescript
import {
  SyncLog,
  TableSchema,
  QueryResponse,
  API_ROUTES,
  DEFAULTS
} from '@chittihq/duckling-shared';

// Use shared types
const log: SyncLog = {
  tableName: 'users',
  syncType: 'incremental',
  recordsProcessed: 1000,
  durationMs: 500,
  status: 'success',
  createdAt: new Date().toISOString(),
};

// Use shared constants
const port = DEFAULTS.PORT; // 3000
const healthUrl = API_ROUTES.HEALTH; // '/health'
```

## What's Included

### Types

- **Sync Types**: `SyncLog`, `SyncStatus`, `Watermark`, `SyncStatusResponse`
- **Table Types**: `TableSchema`, `TableColumn`, `TableMetadata`, `TableDataResponse`
- **Query Types**: `QueryRequest`, `QueryResponse`, `QueryError`
- **Health Types**: `HealthResponse`, `StatusResponse`, `DatabaseHealth`

### Constants

- **API_ROUTES**: All API endpoint paths
- **DEFAULTS**: Default configuration values
- **ARCHITECTURE**: Architecture identifier (`'sequential-appender'`)

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Type check
pnpm type-check
```
