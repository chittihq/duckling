# DuckDB WebSocket SDK

High-performance TypeScript SDK for connecting to DuckDB server via WebSocket. Designed for low-latency, high-throughput query execution with automatic reconnection.

## Features

- **Auto-Connect**: Automatically connects on first query (no manual connect() needed)
- **Auto-Ping**: Keeps connection alive with automatic health checks every 30s
- **WebSocket Connection**: Persistent connection with 5-15ms latency (vs 50-100ms for HTTP)
- **API Key Authentication**: Secure authentication using DUCKLING_API_KEY
- **Auto-Reconnection**: Automatic reconnection with exponential backoff
- **Parallel Queries**: Execute multiple queries concurrently
- **Type-Safe**: Full TypeScript support with type inference
- **High Throughput**: 10,000+ queries/second capability
- **Error Handling**: Comprehensive error handling and timeout management

## Installation

```bash
cd sdk
pnpm install
pnpm run build
```

## Quick Start

```typescript
import { DucklingClient } from '@chittihq/duckling';

// Initialize client - auto-connect and auto-ping enabled by default
const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY,
  databaseName: 'default'  // Optional - defaults to 'default'
});

// Just query - client auto-connects on first query!
const users = await client.query('SELECT * FROM User LIMIT 10');

// Auto-ping keeps connection alive
// Close when done
client.close();
```

## Multi-Database Support

Each WebSocket connection is bound to **one database**. To query multiple databases, create multiple client instances:

```typescript
// Connect to different databases
const lmsClient = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY,
  databaseName: 'lms'
});

const chittiClient = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY,
  databaseName: 'chitti_common'
});

// Each client queries its own database
const lmsUsers = await lmsClient.query('SELECT * FROM User');
const chittiActions = await chittiClient.query('SELECT * FROM Action');

// Clean up
lmsClient.close();
chittiClient.close();
```

## TypeScript Support

The SDK provides comprehensive TypeScript types for full type safety and IntelliSense support.

### Typed Query Results

```typescript
// Define your schema
interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

// Get fully-typed results
const users = await client.query<User>('SELECT * FROM User LIMIT 10');
// users is typed as User[]
// Full IntelliSense for users[0].email, users[0].name, etc.
```

### Available Types

```typescript
import {
  DucklingClient,

  // Core types
  QueryMessage,
  QueryResponse,

  // Config types
  DuckDBSDKConfig,
  ConnectionStats,
  ConnectionState,

  // Query result types
  CountResult,
  AggregateResult,
  QueryRow,

  // Pagination types
  PaginationOptions,
  PaginatedResult,

  // Batch query types
  BatchQueryRequest,
  BatchQueryResult,

  // Event types
  DucklingClientEvents,

  // Error types
  DuckDBError,
  DuckDBErrorType
} from '@chittihq/duckling';
```

For complete type documentation, see [TYPES.md](./TYPES.md).

## Configuration

```typescript
interface DuckDBSDKConfig {
  url: string;                    // WebSocket server URL
  apiKey: string;                 // API key for authentication
  databaseName?: string;          // Database to connect to (default: 'default')
  autoConnect?: boolean;          // Auto-connect on first query (default: true)
  autoPing?: boolean;             // Auto-ping to keep alive (default: true)
  pingInterval?: number;          // Ping interval in ms (default: 30000)
  autoReconnect?: boolean;        // Auto-reconnect on failure (default: true)
  maxReconnectAttempts?: number;  // Max reconnection attempts (default: 5)
  reconnectDelay?: number;        // Reconnect delay in ms (default: 1000)
  connectionTimeout?: number;     // Connection timeout in ms (default: 5000)
  requestTimeout?: number;        // Per-request timeout in ms (default: 30000)
}
```

## API Reference

### `DucklingClient`

#### `connect(): Promise<void>`
Connect to DuckDB server and authenticate with API key.

```typescript
await client.connect();
```

#### `query<T>(sql: string, params?: any[]): Promise<T[]>`
Execute SQL query and return results.

```typescript
const users = await client.query<User>('SELECT * FROM User WHERE id = ?', [123]);
```

#### `queryBatch<T>(queries: string[]): Promise<T[][]>`
Execute multiple queries in parallel.

```typescript
const results = await client.queryBatch([
  'SELECT COUNT(*) FROM User',
  'SELECT COUNT(*) FROM Product'
]);
```

#### `queryPaginated<T>(sql: string, options: PaginationOptions): Promise<PaginatedResult<T>>`
Execute paginated query with automatic LIMIT and OFFSET.

```typescript
const result = await client.queryPaginated<User>(
  'SELECT * FROM User ORDER BY createdAt DESC',
  { limit: 20, offset: 0 }
);

console.log(`Showing ${result.data.length} users`);
console.log(`Has more: ${result.pagination.hasMore}`);
```

#### `queryBatchDetailed<T>(requests: BatchQueryRequest[]): Promise<BatchQueryResult<T>[]>`
Execute batch queries with individual success/failure handling.

```typescript
const requests: BatchQueryRequest[] = [
  { sql: 'SELECT * FROM User LIMIT 10' },
  { sql: 'SELECT * FROM Order LIMIT 10' }
];

const results = await client.queryBatchDetailed(requests);

results.forEach((result) => {
  if (result.success) {
    console.log(`Success: ${result.data?.length} rows in ${result.duration}ms`);
  } else {
    console.error(`Failed: ${result.error}`);
  }
});
```

#### `ping(): Promise<boolean>`
Test connection with ping.

```typescript
const isAlive = await client.ping();
```

#### `close(): void`
Close WebSocket connection.

```typescript
client.close();
```

#### `isConnected(): boolean`
Check if client is connected and authenticated.

```typescript
if (client.isConnected()) {
  // Execute queries
}
```

#### `getStats()`
Get connection statistics.

```typescript
const stats = client.getStats();
console.log(stats);
// {
//   connected: true,
//   authenticated: true,
//   pendingRequests: 2,
//   reconnectAttempts: 0,
//   url: 'ws://localhost:3001/ws'
// }
```

## Examples

### Basic Query

```bash
pnpm run example:basic
```

Simple query execution with auto-connect:

```typescript
import { DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY
  // autoConnect: true (default)
  // autoPing: true (default - keeps connection alive)
});

// Just query - auto-connects on first use!
const users = await client.query('SELECT * FROM User LIMIT 5');
console.table(users);
client.close();
```

### Parallel Queries

```bash
pnpm run example:parallel
```

Execute multiple queries concurrently for maximum throughput:

```typescript
const queries = [
  'SELECT COUNT(*) FROM User',
  'SELECT COUNT(*) FROM Product',
  'SELECT COUNT(*) FROM ActivityLog'
];

const results = await client.queryBatch(queries);
// 3-5x faster than sequential execution
```

## Performance

### Latency Comparison

| Method | Average Latency | Use Case |
|--------|----------------|----------|
| HTTP API | 50-100ms | Standard queries |
| WebSocket (this SDK) | 5-15ms | Real-time dashboards |

### Throughput

- **Sequential**: ~20-50 queries/second
- **Parallel (single connection)**: ~500-1,000 queries/second
- **Maximum Capacity**: 10,000+ queries/second

## Error Handling

The SDK emits events for connection lifecycle:

```typescript
client.on('connected', () => {
  console.log('Connected to DuckDB server');
});

client.on('disconnected', () => {
  console.log('Disconnected from server');
});

client.on('error', (error) => {
  console.error('WebSocket error:', error);
});

client.on('reconnecting', (attempt) => {
  console.log(`Reconnect attempt ${attempt}`);
});

client.on('reconnectExhausted', (attempts, error) => {
  console.error(`Reconnect exhausted after ${attempts} attempts`, error);
});

client.on('message', (response) => {
  console.log('Received message:', response.id);
});
```

Handle query errors with try-catch:

```typescript
try {
  const result = await client.query('SELECT * FROM NonExistentTable');
} catch (error) {
  console.error('Query failed:', error.message);
}
```

## Auto-Connect & Auto-Ping

The SDK automatically connects on first query and keeps the connection alive:

```typescript
import { DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY
  // autoConnect: true (default)
  // autoPing: true (default)
  // pingInterval: 30000 (default - ping every 30s)
});

// No need to call connect() - auto-connects on first query!
const result = await client.query('SELECT * FROM User');

// Auto-ping keeps connection alive automatically
// Perfect for long-running connections
```

## Auto-Reconnection

The SDK automatically reconnects on connection failure:

```typescript
const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: 'your-api-key',
  autoReconnect: true,          // default: true
  maxReconnectAttempts: 5,      // default: 5
  reconnectDelay: 1000,         // default: 1000ms, exponential backoff
  requestTimeout: 30000         // default: 30000ms
});

// Connection will auto-reconnect up to 5 times on failure
// Delays: 1s, 2s, 4s, 8s, 16s
// Close codes 1008 (auth/policy) and 1011 (server/internal) do not auto-reconnect
```

## Environment Variables

```bash
# .env
DUCKLING_API_KEY=your-api-key-here
DUCKLING_WS_URL=ws://localhost:3001/ws  # Optional
```

## Architecture

```
Dashboard → SDK → WebSocket → DuckDB Server
            ↓
     [Auto-Reconnect]
     [Parallel Queries]
```

## Use Cases

### Real-Time Dashboards
```typescript
// Update dashboard every second with fresh data
setInterval(async () => {
  const stats = await client.query('SELECT * FROM dashboard_stats');
  updateUI(stats);
}, 1000);
```

### Batch Processing
```typescript
// Process 1000 queries efficiently
const queries = generateQueries(1000);
const batchSize = 50;

for (let i = 0; i < queries.length; i += batchSize) {
  const batch = queries.slice(i, i + batchSize);
  const results = await client.queryBatch(batch);
  processBatch(results);
}
```

### Microservices Integration
```typescript
// API endpoint handler
app.get('/api/users/:id', async (req, res) => {
  const user = await client.query(
    'SELECT * FROM User WHERE id = ?',
    [req.params.id]
  );
  res.json(user[0]);
});
```

## Requirements

- Node.js 18+
- TypeScript 5.0+
- DuckDB Server with WebSocket support
- Valid DUCKLING_API_KEY

## License

MIT
