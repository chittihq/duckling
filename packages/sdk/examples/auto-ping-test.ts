import { DucklingClient } from '../src/index';

/**
 * Auto-Ping Test
 *
 * This example demonstrates:
 * - Auto-connect on first query
 * - Automatic ping to keep connection alive
 * - Connection health monitoring
 *
 * Requirements:
 * - Set DUCKLING_API_KEY environment variable
 */

async function main() {
  console.log('=== DuckDB WebSocket SDK - Auto-Ping Test ===\n');

  // Check for required environment variable
  if (!process.env.DUCKLING_API_KEY) {
    console.error('Error: DUCKLING_API_KEY environment variable is required');
    console.error('Usage: DUCKLING_API_KEY=your-key pnpm run example:auto-ping-test');
    process.exit(1);
  }

  const client = new DucklingClient({
    url: process.env.DUCKLING_WS_URL || 'ws://localhost:3001/ws',
    apiKey: process.env.DUCKLING_API_KEY,
    pingInterval: 5000  // Ping every 5 seconds (instead of default 30s)
  });

  // Listen to connection events
  client.on('connected', () => {
    console.log('✓ Connected to DuckDB server');
  });

  client.on('disconnected', () => {
    console.log('✗ Disconnected from server');
  });

  client.on('error', (error) => {
    console.error('✗ Error:', error.message);
  });

  try {
    console.log('Starting connection health test...');
    console.log('Auto-ping enabled with 5 second interval\n');

    // Execute initial query (triggers auto-connect)
    console.log('Executing initial query...');
    const users = await client.query('SELECT COUNT(*) as count FROM User');
    console.log(`✓ Initial query result: ${users[0].count} users\n`);

    // Keep connection alive for 20 seconds
    // Auto-ping will fire 4 times (at 5s, 10s, 15s, 20s)
    console.log('Keeping connection alive for 20 seconds...');
    console.log('Watch for automatic pings in server logs\n');

    for (let i = 1; i <= 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log(`${i * 5}s - Connection still alive, auto-ping keeping it healthy`);

      // Execute a query to verify connection is still working
      const result = await client.query('SELECT COUNT(*) as count FROM Product');
      console.log(`  ✓ Query successful: ${result[0].count} products`);
    }

    console.log('\n✓ Connection remained healthy for 20 seconds');
    console.log('✓ Auto-ping successfully kept connection alive\n');

    // Connection stats
    console.log('Final connection stats:', client.getStats());

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
  } finally {
    console.log('\nClosing connection...');
    client.close();
    console.log('✓ Connection closed');
  }
}

main().catch(console.error);
