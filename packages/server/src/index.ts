import './instrument';
import * as Sentry from '@sentry/node';
import DuckDBServer from './server';
import logger from './logger';
import config from './config';
import * as fs from 'fs';
import * as path from 'path';
import { CDCService } from './services/cdcService';

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
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  Sentry.captureException(reason);
  Sentry.close(2000).finally(() => process.exit(1));
});

// Track if shutdown is in progress to prevent duplicate handling
let isShuttingDown = false;

/**
 * Graceful shutdown handler - stops CDC pipeline, closes HTTP server
 */
async function gracefulShutdown(signal: string, server: DuckDBServer): Promise<void> {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}, starting graceful shutdown...`);

  try {
    // Stop all CDC instances first (waits for event queues to drain)
    console.log('Stopping CDC services...');
    await CDCService.stopAll();
    console.log('CDC services stopped');

    // Close HTTP server
    console.log('Closing HTTP server...');
    await server.stop();
    console.log('HTTP server closed');

    console.log('Flushing Sentry events...');
    await Sentry.close(2000);

    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    await Sentry.close(2000);
    process.exit(1);
  }
}

async function main() {
  try {
    console.log('Starting DuckDB Parquet Server...');
    console.log('Architecture: Micro-batch Parquet with partitioned storage');
    console.log('Features: Columnar storage, partition pruning, schema evolution, view management');

    // Check data directory for persistence debugging
    const dataDir = config.paths.data;
    console.log('\n📁 Data Directory Check:');
    console.log(`   Path: ${dataDir}`);

    if (!fs.existsSync(dataDir)) {
      console.log('   ❌ Data directory does not exist - will be created');
      fs.mkdirSync(dataDir, { recursive: true });
    } else {
      const files = fs.readdirSync(dataDir);
      if (files.length === 0) {
        console.log('   ⚠️  Data directory is EMPTY - fresh start (full sync expected)');
      } else {
        console.log(`   ✅ Data directory contains ${files.length} file(s) - persistence working!`);
        files.forEach(file => {
          const filePath = path.join(dataDir, file);
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
          console.log(`      - ${file} (${sizeMB} MB)`);
        });
      }
    }
    console.log('');

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

    // Register graceful shutdown handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT', server));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', server));

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