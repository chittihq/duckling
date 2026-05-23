# @chittihq/duckling-frontend

Web dashboard for the Duckling ClickHouse-backed MySQL replica server. Nuxt 4 + Tailwind + shadcn-vue.

## Features

- Database selector (multi-database per server)
- Tables browser, schema view, query interface
- `/replication` page: capability probe, bootstrap status + actions, mode picker (peerdb / polling / none / auto), known-blocker surfacing
- `/backups` page: S3 backup config + test connection, take-backup-now, backup history, restore + delete
- Sync status, logs, query observability
- Real-time updates via the shared SDK over WebSocket

## Development

```bash
# Install dependencies (from monorepo root)
pnpm install

# Start development server
pnpm --filter @chittihq/duckling-frontend dev

# Build for production
pnpm --filter @chittihq/duckling-frontend build

# Preview production build
pnpm --filter @chittihq/duckling-frontend preview
```

## API Integration

The frontend connects to the DuckDB server backend via:
- Development proxy (configured in `nuxt.config.ts`)
- WebSocket SDK for real-time queries (`@chittihq/duckling`)
- REST API for status and control endpoints

## Project Structure

```
app/
├── components/    # Vue components
│   └── ui/       # shadcn-vue components
├── pages/        # Nuxt pages/routes
├── layouts/      # Nuxt layouts
└── assets/       # Static assets
    └── css/      # Global styles
```

## Configuration

See `nuxt.config.ts` for:
- API proxy settings
- Module configuration
- Build settings
