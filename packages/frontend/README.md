# @lmes/duckling-frontend

Modern web dashboard for Duckling DuckDB Server built with Nuxt 4, Tailwind CSS, and shadcn-vue.

## Features

- Real-time server monitoring
- Table browser and query interface
- Sync status and logs viewer
- Built with Nuxt 4 for optimal performance
- shadcn-vue components for beautiful UI
- Tailwind CSS for styling
- TypeScript support

## Development

```bash
# Install dependencies (from monorepo root)
pnpm install

# Start development server
pnpm --filter @lmes/duckling-frontend dev

# Build for production
pnpm --filter @lmes/duckling-frontend build

# Preview production build
pnpm --filter @lmes/duckling-frontend preview
```

## API Integration

The frontend connects to the DuckDB server backend via:
- Development proxy (configured in `nuxt.config.ts`)
- WebSocket SDK for real-time queries (`@lmes/duckling`)
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
