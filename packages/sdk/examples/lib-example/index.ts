import { DucklingClient } from '@chittihq/duckling';

/**
 * Basic Query Example
 *
 * This example demonstrates:
 * - Connecting to DuckDB server via WebSocket
 * - Authenticating with API key
 * - Executing a simple query
 * - Handling results
 * - Graceful connection closing
 *
 * Requirements:
 * - Set DUCKLING_API_KEY environment variable
 */

async function main() {
  console.log('=== Duckling WebSocket SDK - Basic Query Example ===\n');

  // Check for required environment variable
  if (!process.env.DUCKLING_API_KEY) {
    console.error('Error: DUCKLING_API_KEY environment variable is required');
    console.error('Usage: DUCKLING_API_KEY=your-key pnpm run example:basic');
    process.exit(1);
  }

  // Initialize client with auto-connect enabled (default)
  const client = new DucklingClient({
    url: process.env.DUCKLING_WS_URL || 'ws://localhost:3001/ws',
    apiKey: process.env.DUCKLING_API_KEY
    // autoConnect: true (default)
    // autoPing: true (default - keeps connection alive every 30s)
  });

  try {
    // Execute query - client will auto-connect on first query
    console.log('Executing query: SELECT * FROM User LIMIT 5');
    console.log('(Auto-connecting to DuckDB server...)');
    const startTime = Date.now();
    const users = await client.query('SELECT * FROM User LIMIT 5');
    const duration = Date.now() - startTime;

    console.log(`✓ Query completed in ${duration}ms`);
    console.log(`✓ Rows returned: ${users.length}\n`);

    // Display results
    console.log('Results:');
    console.table(users);

    // Get table count
    console.log('\nGetting total user count...');
    const countResult = await client.query<{ count: number }>('SELECT COUNT(*) as count FROM User');
    console.log(`✓ Total users: ${countResult[0].count}\n`);

    // Connection stats
    console.log('Connection stats:', client.getStats());

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
  } finally {
    // Always close the connection
    console.log('\nClosing connection...');
    client.close();
    console.log('✓ Connection closed');
  }
}

// Run the example
main().catch(console.error);
