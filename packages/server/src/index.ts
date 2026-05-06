import './instrument';
import * as Sentry from '@sentry/node';
import ClickHouseServer from './server';
import logger from './logger';
import config from './config';
import * as fs from 'fs';
import * as path from 'path';

// Enable garbage collection if available
if (global.gc) {
  logger.info('Garbage collection is available');
} else {
  logger.warn('Garbage collection is not available - consider running with --expose-gc flag');
}

// Add memory monitoring
const formatMB = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;

const getProcessSnapshot = () => {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMB: formatMB(usage.rss),
    heapUsedMB: formatMB(usage.heapUsed),
    heapTotalMB: formatMB(usage.heapTotal),
    externalMB: formatMB(usage.external),
  };
};

const logMemoryUsage = () => {
  logger.info('Memory Usage:', {
    rss: `${getProcessSnapshot().rssMB} MB`,
    heapTotal: `${getProcessSnapshot().heapTotalMB} MB`,
    heapUsed: `${getProcessSnapshot().heapUsedMB} MB`,
    external: `${getProcessSnapshot().externalMB} MB`
  });
  
  // Force GC if heap usage is high
  const usage = process.memoryUsage();
  if (global.gc && usage.heapUsed > usage.heapTotal * 0.8) {
    logger.info('High memory usage detected, running garbage collection');
    global.gc();
  }
};

const installRuntimeDiagnostics = (logsDir: string) => {
  if (config.debug.crashDiagnostics && process.report) {
    try {
      process.report.directory = logsDir;
      process.report.reportOnFatalError = true;
      process.report.reportOnUncaughtException = true;
      process.report.reportOnSignal = true;
      process.report.signal = 'SIGUSR2';
      logger.info('Crash diagnostics enabled', {
        logsDir,
        reportOnFatalError: process.report.reportOnFatalError,
        reportOnSignal: process.report.reportOnSignal,
        signal: process.report.signal,
      });
    } catch (error) {
      logger.warn('Failed to enable Node.js process reports:', error);
    }
  }

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('Uncaught Exception Monitor:', {
      origin,
      error,
      process: getProcessSnapshot(),
    });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning:', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
      process: getProcessSnapshot(),
    });
  });

  process.on('multipleResolves', (type, promise, value) => {
    logger.warn('Promise multipleResolves detected:', {
      type,
      value,
      promise,
      process: getProcessSnapshot(),
    });
  });

  process.on('beforeExit', (code) => {
    if (!config.debug.crashDiagnostics) return;
    logger.info('Process beforeExit', { code, process: getProcessSnapshot() });
  });

  process.on('exit', (code) => {
    if (!config.debug.crashDiagnostics) return;
    logger.info('Process exit', { code, process: getProcessSnapshot() });
  });
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
async function gracefulShutdown(signal: string, server: ClickHouseServer): Promise<void> {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}, starting graceful shutdown...`);

  try {
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
    console.log('Starting Duckling Server...');

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
    installRuntimeDiagnostics(logsDir);

    const server = new ClickHouseServer();
    console.log('ClickHouse Server instance created');

    await server.start();
    console.log('Server started successfully');

    // Note: Initial sync is handled by the automation service
    // See automationService.ts startPeriodicSync() for automatic sync configuration

    // Register graceful shutdown handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT', server));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', server));

    console.log('ClickHouse Server started successfully and is ready to accept connections');
    console.log('🚀 New Features Available:');
    console.log('  • ClickHouse-backed analytical queries');
    console.log('  • MySQL-to-ClickHouse incremental sync');
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
