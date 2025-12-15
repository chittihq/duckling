# DuckDB SDK TypeScript Types

Comprehensive type definitions for the DuckDB WebSocket SDK, providing full type safety and IntelliSense support.

## Table of Contents

- [Core Types](#core-types)
- [Configuration Types](#configuration-types)
- [Query Result Types](#query-result-types)
- [Pagination Types](#pagination-types)
- [Batch Query Types](#batch-query-types)
- [Event Types](#event-types)
- [Error Types](#error-types)
- [Utility Types](#utility-types)
- [Usage Examples](#usage-examples)

## Core Types

### QueryMessage

Message sent to the DuckDB server:

```typescript
interface QueryMessage {
  id: string;                  // Unique message identifier
  type: 'query' | 'ping' | 'auth';
  sql?: string;                // SQL query (for 'query' type)
  params?: any[];              // Optional query parameters
  apiKey?: string;             // API key (for 'auth' type)
}
```

### QueryResponse

Response from the DuckDB server:

```typescript
interface QueryResponse<T = any> {
  id: string;                  // Message ID this responds to
  success: boolean;            // Operation success status
  result?: T[];                // Query results (on success)
  error?: string;              // Error message (on failure)
  duration?: number;           // Query duration in milliseconds
}
```

## Configuration Types

### DuckDBSDKConfig

Client configuration options:

```typescript
interface DuckDBSDKConfig {
  url: string;                      // WebSocket server URL
  apiKey: string;                   // API authentication key
  autoConnect?: boolean;            // Auto-connect on first query (default: true)
  autoReconnect?: boolean;          // Auto-reconnect on failure (default: true)
  maxReconnectAttempts?: number;    // Max reconnect attempts (default: 5)
  reconnectDelay?: number;          // Reconnect delay in ms (default: 1000)
  connectionTimeout?: number;       // Connection timeout in ms (default: 5000)
  autoPing?: boolean;               // Keep-alive ping (default: true)
  pingInterval?: number;            // Ping interval in ms (default: 30000)
}
```

### ConnectionStats

Connection statistics:

```typescript
interface ConnectionStats {
  connected: boolean;          // Currently connected and authenticated
  authenticated: boolean;      // Successfully authenticated
  pendingRequests: number;     // Requests waiting for response
  reconnectAttempts: number;   // Reconnection attempts made
  url: string;                 // WebSocket server URL
}
```

## Query Result Types

### Typed Query Results

Define your table schema and get full type safety:

```typescript
// Define your schema
interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

// Query with type safety
const users = await client.query<User>('SELECT * FROM User LIMIT 10');
// users is typed as User[]
// TypeScript knows: users[0].email, users[0].name exist
```

### CountResult

For COUNT queries:

```typescript
interface CountResult {
  count: number;
}

const result = await client.query<CountResult>('SELECT COUNT(*) as count FROM User');
const totalUsers = result[0].count; // number
```

### AggregateResult

For aggregate queries:

```typescript
interface AggregateResult {
  count?: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
}
```

### Custom Result Types

Create custom types for complex queries:

```typescript
interface UserWithOrderCount {
  id: number;
  name: string;
  email: string;
  orderCount: number;
}

const users = await client.query<UserWithOrderCount>(`
  SELECT u.*, COUNT(o.id) as orderCount
  FROM User u
  LEFT JOIN Order o ON u.id = o.userId
  GROUP BY u.id
`);
```

## Pagination Types

### PaginationOptions

Options for paginated queries:

```typescript
interface PaginationOptions {
  limit: number;   // Number of rows to return
  offset: number;  // Number of rows to skip
}
```

### PaginatedResult

Paginated query result:

```typescript
interface PaginatedResult<T = QueryRow> {
  data: T[];                   // Result rows
  pagination: {
    offset: number;            // Current offset
    limit: number;             // Requested limit
    total?: number;            // Total rows (if available)
    hasMore?: boolean;         // Whether more rows exist
  };
}
```

### Usage Example

```typescript
const paginationOptions: PaginationOptions = {
  limit: 20,
  offset: 0
};

const result = await client.queryPaginated<User>(
  'SELECT * FROM User ORDER BY createdAt DESC',
  paginationOptions
);

console.log(`Showing ${result.data.length} of ${result.pagination.total} users`);
console.log(`Has more: ${result.pagination.hasMore}`);
```

## Batch Query Types

### BatchQueryRequest

Individual batch query request:

```typescript
interface BatchQueryRequest {
  sql: string;         // SQL query
  params?: any[];      // Optional parameters
}
```

### BatchQueryResult

Individual batch query result:

```typescript
interface BatchQueryResult<T = QueryRow> {
  query: string;       // Original query
  success: boolean;    // Query success status
  data?: T[];          // Results (on success)
  error?: string;      // Error message (on failure)
  duration?: number;   // Execution time in ms
}
```

### Usage Example

```typescript
const requests: BatchQueryRequest[] = [
  { sql: 'SELECT * FROM User LIMIT 10' },
  { sql: 'SELECT * FROM Order LIMIT 10' },
  { sql: 'SELECT COUNT(*) as count FROM User' }
];

const results = await client.queryBatchDetailed<QueryRow>(requests);

results.forEach((result, index) => {
  if (result.success) {
    console.log(`Query ${index + 1}: ${result.data?.length} rows in ${result.duration}ms`);
  } else {
    console.error(`Query ${index + 1}: ${result.error}`);
  }
});
```

## Event Types

### DucklingClientEvents

Strongly-typed event interface:

```typescript
interface DucklingClientEvents {
  connected: () => void;           // Connected to server
  disconnected: () => void;        // Disconnected from server
  error: (error: Error) => void;   // Error occurred
  reconnecting: (attempt: number) => void;  // Reconnection attempt
  message: (response: QueryResponse) => void;  // Message received
}
```

### Type-Safe Event Handling

```typescript
// TypeScript ensures correct event names and signatures
client.on('connected', () => {
  console.log('Connected!');
});

client.on('error', (error: Error) => {
  console.error('Error:', error.message);
});

client.on('reconnecting', (attempt: number) => {
  console.log(`Reconnection attempt ${attempt}`);
});
```

## Error Types

### DuckDBErrorType

Error type enumeration:

```typescript
enum DuckDBErrorType {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  AUTH_ERROR = 'AUTH_ERROR',
  QUERY_ERROR = 'QUERY_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}
```

### DuckDBError

Enhanced error class:

```typescript
class DuckDBError extends Error {
  constructor(
    public type: DuckDBErrorType,
    message: string,
    public context?: Record<string, any>
  )
}
```

### Usage Example

```typescript
try {
  await client.query('SELECT * FROM NonExistentTable');
} catch (error) {
  if (error instanceof DuckDBError) {
    console.error(`${error.type}: ${error.message}`);
    console.error('Context:', error.context);
  }
}
```

## Utility Types

### InferRowType

Extract row type from query promise:

```typescript
type UserRow = InferRowType<typeof client.query<User>('SELECT * FROM User')>;
// UserRow is User
```

### RequireProperties

Make specific properties required:

```typescript
type ConfigWithUrl = RequireProperties<DuckDBSDKConfig, 'url' | 'apiKey'>;
```

### OptionalProperties

Make specific properties optional:

```typescript
type PartialConfig = OptionalProperties<DuckDBSDKConfig, 'autoConnect' | 'autoPing'>;
```

### DeepPartial

Deep partial type:

```typescript
type PartialConfig = DeepPartial<DuckDBSDKConfig>;
```

### MaybePromise

Value that may or may not be a promise:

```typescript
type MaybePromise<T> = T | Promise<T>;
```

## Usage Examples

### Basic Typed Query

```typescript
import { DucklingClient } from '@chittihq/duckling';

interface User {
  id: number;
  name: string;
  email: string;
}

const client = new DucklingClient({
  url: 'ws://localhost:3001/ws',
  apiKey: process.env.DUCKLING_API_KEY
});

const users = await client.query<User>('SELECT * FROM User LIMIT 10');
// users: User[]
// Full IntelliSense for users[0].email, users[0].name, etc.
```

### Pagination

```typescript
const result = await client.queryPaginated<User>(
  'SELECT * FROM User ORDER BY createdAt DESC',
  { limit: 20, offset: 0 }
);

console.log(`Page: ${result.data.length} users`);
console.log(`Has more: ${result.pagination.hasMore}`);
```

### Batch Queries

```typescript
const results = await client.queryBatchDetailed<QueryRow>([
  { sql: 'SELECT * FROM User LIMIT 10' },
  { sql: 'SELECT * FROM Order LIMIT 10' }
]);

results.forEach(result => {
  if (result.success) {
    console.log(`Success: ${result.data?.length} rows`);
  } else {
    console.error(`Failed: ${result.error}`);
  }
});
```

### Custom Aggregate Types

```typescript
interface OrderStats {
  totalOrders: number;
  totalRevenue: number;
  avgOrderValue: number;
}

const stats = await client.query<OrderStats>(`
  SELECT
    COUNT(*) as totalOrders,
    SUM(total) as totalRevenue,
    AVG(total) as avgOrderValue
  FROM Order
`);

console.log(`Average order: $${stats[0].avgOrderValue.toFixed(2)}`);
```

### Event Handling

```typescript
client.on('connected', () => {
  console.log('Connected to DuckDB');
});

client.on('error', (error: Error) => {
  console.error('Connection error:', error.message);
});

client.on('disconnected', () => {
  console.log('Disconnected, will auto-reconnect...');
});
```

### Type-Safe Configuration

```typescript
const config: DuckDBSDKConfig = {
  url: 'ws://localhost:3001/ws',
  apiKey: 'your-api-key',
  autoConnect: true,
  autoPing: true,
  pingInterval: 30000,
  maxReconnectAttempts: 5
};

const client = new DucklingClient(config);
```

## Best Practices

### 1. Define Schema Types

Create TypeScript interfaces matching your database schema:

```typescript
// schema.ts
export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: number;
  userId: number;
  total: number;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: string;
}
```

### 2. Use Generic Type Parameters

Always specify the expected result type:

```typescript
// ✓ Good - type-safe
const users = await client.query<User>('SELECT * FROM User');

// ✗ Bad - loses type information
const users = await client.query('SELECT * FROM User');
```

### 3. Create Custom Types for Complex Queries

```typescript
interface UserWithOrderCount extends User {
  orderCount: number;
}

const users = await client.query<UserWithOrderCount>(`
  SELECT u.*, COUNT(o.id) as orderCount
  FROM User u
  LEFT JOIN Order o ON u.id = o.userId
  GROUP BY u.id
`);
```

### 4. Handle Errors with Type Guards

```typescript
try {
  await client.query<User>('SELECT * FROM User');
} catch (error) {
  if (error instanceof DuckDBError) {
    // Handle DuckDB-specific errors
    console.error(`${error.type}: ${error.message}`);
  } else if (error instanceof Error) {
    // Handle generic errors
    console.error(error.message);
  }
}
```

### 5. Use Typed Events

```typescript
// TypeScript ensures correct event signatures
client.on('connected', () => {
  console.log('Connected!');
});

client.on('error', (error: Error) => {
  console.error(error.message);
});
```

## Type Exports

All types are exported from the main package:

```typescript
import {
  // Client
  DucklingClient,

  // Core types
  QueryMessage,
  QueryResponse,

  // Config types
  DuckDBSDKConfig,
  ConnectionStats,

  // Query types
  CountResult,
  AggregateResult,
  QueryRow,

  // Pagination types
  PaginationOptions,
  PaginatedResult,

  // Batch types
  BatchQueryRequest,
  BatchQueryResult,

  // Event types
  DucklingClientEvents,

  // Error types
  DuckDBError,
  DuckDBErrorType,

  // Utility types
  InferRowType,
  RequireProperties,
  OptionalProperties,
  DeepPartial,
  MaybePromise
} from '@chittihq/duckling';
```
