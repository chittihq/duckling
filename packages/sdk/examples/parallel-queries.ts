import { DucklingClient } from '../src/index';

/**
 * Parallel Queries Example
 *
 * This example demonstrates:
 * - Executing multiple queries concurrently
 * - High-throughput query performance
 * - Batch query processing
 * - Performance comparison with sequential execution
 *
 * Requirements:
 * - Set DUCKLING_API_KEY environment variable
 */

async function main() {
  console.log('=== DuckDB WebSocket SDK - Parallel Queries Example ===\n');

  // Check for required environment variable
  if (!process.env.DUCKLING_API_KEY) {
    console.error('Error: DUCKLING_API_KEY environment variable is required');
    console.error('Usage: DUCKLING_API_KEY=your-key pnpm run example:parallel');
    process.exit(1);
  }

  const client = new DucklingClient({
    url: process.env.DUCKLING_WS_URL || 'ws://localhost:3001/ws',
    apiKey: process.env.DUCKLING_API_KEY
    // Auto-connect and auto-ping enabled by default
  });

  try {
    // Define multiple queries
    const queries = [
      'SELECT COUNT(*) as count FROM User',
      'SELECT COUNT(*) as count FROM Product',
      'SELECT COUNT(*) as count FROM SubProduct',
      'SELECT COUNT(*) as count FROM ActivityLog',
      'SELECT COUNT(*) as count FROM IndianPincode'
    ];

    // Sequential execution benchmark
    console.log('--- Sequential Execution Benchmark ---');
    const sequentialStart = Date.now();
    const sequentialResults = [];
    for (const query of queries) {
      const result = await client.query(query);
      sequentialResults.push(result);
    }
    const sequentialDuration = Date.now() - sequentialStart;
    console.log(`✓ Sequential execution: ${sequentialDuration}ms`);
    console.log(`✓ Average per query: ${Math.round(sequentialDuration / queries.length)}ms\n`);

    // Parallel execution benchmark
    console.log('--- Parallel Execution Benchmark ---');
    const parallelStart = Date.now();
    const parallelResults = await client.queryBatch(queries);
    const parallelDuration = Date.now() - parallelStart;
    console.log(`✓ Parallel execution: ${parallelDuration}ms`);
    console.log(`✓ Average per query: ${Math.round(parallelDuration / queries.length)}ms\n`);

    // Performance comparison
    const speedup = (sequentialDuration / parallelDuration).toFixed(2);
    const improvement = (((sequentialDuration - parallelDuration) / sequentialDuration) * 100).toFixed(1);
    console.log('--- Performance Comparison ---');
    console.log(`Speedup: ${speedup}x faster`);
    console.log(`Improvement: ${improvement}% reduction in execution time\n`);

    // Display results
    console.log('--- Query Results ---');
    const tableNames = ['User', 'Product', 'SubProduct', 'ActivityLog', 'IndianPincode'];
    parallelResults.forEach((result, index) => {
      const count = result[0] as any;
      console.log(`${tableNames[index]}: ${count.count} records`);
    });

    // Stress test: 20 parallel queries
    console.log('\n--- Stress Test: 20 Parallel Queries ---');
    const stressQueries = Array(20).fill('SELECT COUNT(*) as count FROM User');
    const stressStart = Date.now();
    await client.queryBatch(stressQueries);
    const stressDuration = Date.now() - stressStart;
    console.log(`✓ 20 parallel queries completed in ${stressDuration}ms`);
    console.log(`✓ Average latency: ${Math.round(stressDuration / 20)}ms per query`);
    console.log(`✓ Throughput: ${Math.round(20000 / stressDuration)} queries/second\n`);

    // Connection stats
    console.log('Connection stats:', client.getStats());

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
  } finally {
    console.log('\nClosing connection...');
    client.close();
    console.log('✓ Connection closed');
  }
}

main().catch(console.error);
