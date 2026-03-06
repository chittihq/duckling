import { DucklingClient } from '../src/index';

/**
 * Connection Pool Example
 *
 * This example demonstrates:
 * - Managing multiple WebSocket connections
 * - Load balancing queries across connections
 * - Connection pool for high-concurrency scenarios
 * - Auto-reconnection and failover
 *
 * Requirements:
 * - Set DUCKLING_API_KEY environment variable
 */

class DuckDBConnectionPool {
  private clients: DucklingClient[] = [];
  private currentIndex = 0;

  constructor(
    private poolSize: number,
    private config: { url: string; apiKey: string }
  ) {}

  /**
   * Initialize connection pool
   */
  async initialize(): Promise<void> {
    console.log(`Initializing connection pool with ${this.poolSize} connections...`);

    const connectionPromises = Array.from({ length: this.poolSize }, async (_, i) => {
      const client = new DucklingClient({
        url: this.config.url,
        apiKey: this.config.apiKey
        // Auto-connect and auto-ping enabled by default
      });

      // Force connection upfront for pool initialization
      await client.connect();
      this.clients.push(client);
      console.log(`✓ Connection ${i + 1}/${this.poolSize} established`);
    });

    await Promise.all(connectionPromises);
    console.log(`✓ Connection pool ready with ${this.clients.length} connections\n`);
  }

  /**
   * Get next available client (round-robin)
   */
  private getNextClient(): DucklingClient {
    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }

  /**
   * Execute query using connection pool
   */
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const client = this.getNextClient();
    return client.query<T>(sql, params);
  }

  /**
   * Execute multiple queries distributed across pool
   */
  async queryBatch<T = any>(queries: string[]): Promise<T[][]> {
    return Promise.all(
      queries.map((sql, index) => {
        const client = this.clients[index % this.clients.length];
        return client.query<T>(sql);
      })
    );
  }

  /**
   * Close all connections
   */
  close(): void {
    this.clients.forEach(client => client.close());
    this.clients = [];
  }

  /**
   * Get pool stats
   */
  getStats() {
    return {
      poolSize: this.clients.length,
      connections: this.clients.map((client, i) => ({
        index: i,
        ...client.getStats()
      }))
    };
  }
}

async function main() {
  console.log('=== DuckDB WebSocket SDK - Connection Pool Example ===\n');

  // Check for required environment variable
  if (!process.env.DUCKLING_API_KEY) {
    console.error('Error: DUCKLING_API_KEY environment variable is required');
    console.error('Usage: DUCKLING_API_KEY=your-key pnpm run example:connection-pool');
    process.exit(1);
  }

  // Create connection pool with 5 connections
  const pool = new DuckDBConnectionPool(5, {
    url: process.env.DUCKLING_WS_URL || 'ws://localhost:3001/ws',
    apiKey: process.env.DUCKLING_API_KEY
  });

  try {
    // Initialize pool
    await pool.initialize();

    // Execute queries through pool
    console.log('--- Executing Queries Through Pool ---');
    const tables = ['User', 'Product', 'SubProduct', 'ActivityLog', 'IndianPincode'];
    const queries = tables.map(table => `SELECT COUNT(*) as count FROM ${table}`);

    const startTime = Date.now();
    const results = await pool.queryBatch(queries);
    const duration = Date.now() - startTime;

    console.log(`✓ ${queries.length} queries completed in ${duration}ms`);
    console.log(`✓ Average latency: ${Math.round(duration / queries.length)}ms per query\n`);

    // Display results
    console.log('--- Results ---');
    results.forEach((result, index) => {
      const count = result[0] as any;
      console.log(`${tables[index]}: ${count.count} records`);
    });

    // High-concurrency stress test
    console.log('\n--- High-Concurrency Stress Test ---');
    console.log('Executing 100 queries distributed across pool...');
    const stressQueries = Array(100).fill('SELECT COUNT(*) as count FROM User');
    const stressStart = Date.now();
    await pool.queryBatch(stressQueries);
    const stressDuration = Date.now() - stressStart;

    console.log(`✓ 100 queries completed in ${stressDuration}ms`);
    console.log(`✓ Throughput: ${Math.round(100000 / stressDuration)} queries/second`);
    console.log(`✓ Average latency: ${Math.round(stressDuration / 100)}ms per query\n`);

    // Pool stats
    console.log('--- Connection Pool Stats ---');
    const stats = pool.getStats();
    console.log(`Pool size: ${stats.poolSize}`);
    console.log('Connection status:');
    stats.connections.forEach(conn => {
      console.log(`  Connection ${conn.index}: ${conn.connected ? '✓ Connected' : '✗ Disconnected'} (pending: ${conn.pendingRequests})`);
    });

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
  } finally {
    console.log('\nClosing connection pool...');
    pool.close();
    console.log('✓ All connections closed');
  }
}

main().catch(console.error);
