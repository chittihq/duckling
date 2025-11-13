import DuckDBServer from './server';
import logger from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Enable garbage collection if available
if (global.gc) {
  logger.info('Garbage collection is available');
} else {
  logger.warn('Garbage collection is not available - consider running with --expose-gc flag');
}

// Add memory monitoring
const logMemoryUsage = () => {
  const usage = process.memoryUsage();
  const formatMB = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  
  logger.info('Memory Usage:', {
    rss: `${formatMB(usage.rss)} MB`,
    heapTotal: `${formatMB(usage.heapTotal)} MB`,
    heapUsed: `${formatMB(usage.heapUsed)} MB`,
    external: `${formatMB(usage.external)} MB`
  });
  
  // Force GC if heap usage is high
  if (global.gc && usage.heapUsed > usage.heapTotal * 0.8) {
    logger.info('High memory usage detected, running garbage collection');
    global.gc();
  }
};

// Log memory usage every 5 minutes
setInterval(logMemoryUsage, 5 * 60 * 1000);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function main() {
  try {
    console.log('Starting DuckDB Parquet Server...');
    console.log('Architecture: Micro-batch Parquet with partitioned storage');
    console.log('Features: Columnar storage, partition pruning, schema evolution, view management');
    
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    console.log('Logs directory created');

    const server = new DuckDBServer();
    console.log('DuckDB Server instance created');

    await server.start();
    console.log('Server started successfully');

    // Note: Initial sync is handled by the automation service
    // See automationService.ts startPeriodicSync() for automatic sync configuration

    process.on('SIGINT', () => {
      console.log('Received SIGINT, shutting down gracefully');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });

    console.log('DuckDB Server started successfully and is ready to accept connections');
    console.log('🚀 New Features Available:');
    console.log('  • Partitioned Parquet storage for better performance');
    console.log('  • Micro-batch incremental sync');
    console.log('  • Automatic schema evolution handling');
    console.log('  • View management with health monitoring');
    console.log('  • Storage cleanup and optimization');
    console.log('  • Migration tools for existing databases');

  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

main();