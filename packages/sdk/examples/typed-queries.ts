import {
  DucklingClient,
  CountResult,
  PaginationOptions,
  BatchQueryRequest,
  QueryRow,
  DucklingClientEvents
} from '../src/index';

/**
 * Typed Queries Example
 *
 * This example demonstrates:
 * - Using TypeScript types for query results
 * - Pagination with typed results
 * - Batch queries with type safety
 * - Event handling with type safety
 *
 * Requirements:
 * - Set DUCKLING_API_KEY environment variable
 */

// Define your table schema types
interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

interface Order {
  id: number;
  userId: number;
  total: number;
  status: string;
  createdAt: string;
}

interface UserWithOrderCount extends User {
  orderCount: number;
}

async function main() {
  console.log('=== DuckDB WebSocket SDK - Typed Queries Example ===\n');

  // Check for required environment variable
  if (!process.env.DUCKLING_API_KEY) {
    console.error('Error: DUCKLING_API_KEY environment variable is required');
    console.error('Usage: DUCKLING_API_KEY=your-key pnpm run example:typed');
    process.exit(1);
  }

  const client = new DucklingClient({
    url: process.env.DUCKLING_WS_URL || 'ws://localhost:3001/ws',
    apiKey: process.env.DUCKLING_API_KEY
  });

  // Event handling with type safety
  client.on('connected', () => {
    console.log('✓ Connected to DuckDB server');
  });

  client.on('error', (error: Error) => {
    console.error('✗ Error:', error.message);
  });

  client.on('disconnected', () => {
    console.log('✓ Disconnected from server');
  });

  try {
    // 1. Basic typed query
    console.log('1. Fetching users with type safety...');
    const users = await client.query<User>('SELECT * FROM User LIMIT 5');
    console.log(`✓ Found ${users.length} users`);
    console.log('First user:', users[0]);
    // TypeScript knows: users is User[]
    // Auto-complete works: users[0].email, users[0].name, etc.

    // 2. COUNT query with specific type
    console.log('\n2. Getting user count...');
    const countResult = await client.query<CountResult>('SELECT COUNT(*) as count FROM User');
    const totalUsers = countResult[0].count;
    console.log(`✓ Total users: ${totalUsers}`);
    // TypeScript knows: countResult[0].count is a number

    // 3. Complex query with custom type
    console.log('\n3. Fetching users with order counts...');
    const usersWithOrders = await client.query<UserWithOrderCount>(`
      SELECT
        u.*,
        COUNT(o.id) as orderCount
      FROM User u
      LEFT JOIN \`Order\` o ON u.id = o.userId
      GROUP BY u.id
      LIMIT 5
    `);
    console.log(`✓ Found ${usersWithOrders.length} users with order data`);
    console.log('Sample:', usersWithOrders[0]);
    // TypeScript knows: usersWithOrders[0].orderCount exists

    // 4. Paginated query
    console.log('\n4. Paginated query...');
    const paginationOptions: PaginationOptions = {
      limit: 10,
      offset: 0
    };

    const paginatedResult = await client.queryPaginated<User>(
      'SELECT * FROM User ORDER BY createdAt DESC',
      paginationOptions
    );

    console.log(`✓ Page returned ${paginatedResult.data.length} users`);
    console.log(`  Offset: ${paginatedResult.pagination.offset}`);
    console.log(`  Limit: ${paginatedResult.pagination.limit}`);
    console.log(`  Has more: ${paginatedResult.pagination.hasMore}`);

    // 5. Batch queries with different types
    console.log('\n5. Batch queries with type safety...');
    const batchRequests: BatchQueryRequest[] = [
      { sql: 'SELECT * FROM User LIMIT 3' },
      { sql: 'SELECT * FROM `Order` LIMIT 3' },
      { sql: 'SELECT COUNT(*) as count FROM User' }
    ];

    const batchResults = await client.queryBatchDetailed<QueryRow>(batchRequests);

    console.log('✓ Batch query results:');
    batchResults.forEach((result, index) => {
      if (result.success) {
        console.log(`  Query ${index + 1}: Success (${result.data?.length} rows, ${result.duration}ms)`);
      } else {
        console.log(`  Query ${index + 1}: Failed - ${result.error}`);
      }
    });

    // 6. Individual batch queries with specific types
    console.log('\n6. Parallel queries with different types...');
    const [userBatch, orderBatch, countBatch] = await Promise.all([
      client.query<User>('SELECT * FROM User LIMIT 5'),
      client.query<Order>('SELECT * FROM `Order` LIMIT 5'),
      client.query<CountResult>('SELECT COUNT(*) as count FROM User')
    ]);

    console.log(`✓ Users: ${userBatch.length}`);
    console.log(`✓ Orders: ${orderBatch.length}`);
    console.log(`✓ Total count: ${countBatch[0].count}`);

    // 7. Aggregate queries
    console.log('\n7. Aggregate query...');
    interface OrderStats {
      totalOrders: number;
      totalRevenue: number;
      avgOrderValue: number;
      minOrderValue: number;
      maxOrderValue: number;
    }

    const stats = await client.query<OrderStats>(`
      SELECT
        COUNT(*) as totalOrders,
        SUM(total) as totalRevenue,
        AVG(total) as avgOrderValue,
        MIN(total) as minOrderValue,
        MAX(total) as maxOrderValue
      FROM \`Order\`
    `);

    console.log('✓ Order statistics:', stats[0]);

    // 8. Get connection stats
    console.log('\n8. Connection statistics:');
    const connectionStats = client.getStats();
    console.log(`  Connected: ${connectionStats.connected}`);
    console.log(`  Authenticated: ${connectionStats.authenticated}`);
    console.log(`  Pending requests: ${connectionStats.pendingRequests}`);
    console.log(`  Reconnect attempts: ${connectionStats.reconnectAttempts}`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
  } finally {
    console.log('\n✓ Closing connection...');
    client.close();
  }
}

// Run the example
main().catch(console.error);
