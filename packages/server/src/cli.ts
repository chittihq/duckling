#!/usr/bin/env node

import { program } from 'commander';
import SequentialAppenderService from './services/sequentialAppenderService';
import DumpService from './services/dumpService';
import MySQLConnection from './database/mysql';
import DuckDBConnection from './database/duckdb';
import logger from './logger';

program
  .name('duckdb-sync')
  .description('DuckDB MySQL Replication CLI')
  .version('1.0.0');

program
  .command('sync')
  .description('Run full synchronization')
  .action(async () => {
    try {
      const syncService = SequentialAppenderService.getInstance();
      const result = await syncService.fullSync();
      console.log('Full sync completed:', result);
    } catch (error) {
      logger.error('Full sync failed:', error);
      process.exit(1);
    }
  });

program
  .command('sync-incremental')
  .description('Run incremental synchronization')
  .action(async () => {
    try {
      const syncService = SequentialAppenderService.getInstance();
      const result = await syncService.incrementalSync();
      console.log('Incremental sync completed:', result);
    } catch (error) {
      logger.error('Incremental sync failed:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show sync status')
  .action(async () => {
    try {
      const syncService = SequentialAppenderService.getInstance();
      const status = await syncService.getSyncStatus();
      console.log('Sync status:', JSON.stringify(status, null, 2));
    } catch (error) {
      logger.error('Failed to get status:', error);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate sync integrity')
  .action(async () => {
    try {
      const syncService = SequentialAppenderService.getInstance();
      const validation = await syncService.validateSync();
      console.log('Validation results:', JSON.stringify(validation, null, 2));
    } catch (error) {
      logger.error('Validation failed:', error);
      process.exit(1);
    }
  });

program
  .command('health')
  .description('Check database connections')
  .action(async () => {
    try {
      const mysql = MySQLConnection.getInstance();
      const duckdb = DuckDBConnection.getInstance();
      
      const mysqlHealthy = await mysql.testConnection();
      const duckdbHealthy = await duckdb.testConnection();
      
      console.log('Health check results:', {
        mysql: mysqlHealthy ? 'healthy' : 'unhealthy',
        duckdb: duckdbHealthy ? 'healthy' : 'unhealthy'
      });
      
      if (!mysqlHealthy || !duckdbHealthy) {
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  });

program
  .command('tables')
  .description('List tables in both databases')
  .action(async () => {
    try {
      const mysql = MySQLConnection.getInstance();
      const duckdb = DuckDBConnection.getInstance();
      
      const mysqlTables = await mysql.getTables();
      const duckdbTables = await duckdb.getTables();
      
      console.log('Tables comparison:', {
        mysql: mysqlTables,
        duckdb: duckdbTables,
        missing: mysqlTables.filter(t => !duckdbTables.includes(t))
      });
    } catch (error) {
      logger.error('Failed to list tables:', error);
      process.exit(1);
    }
  });

// Dump commands
program
  .command('dump-create')
  .description('Create a full database dump')
  .action(async () => {
    try {
      const dumpService = DumpService.getInstance();
      const result = await dumpService.createFullDump();
      
      if (result.success) {
        console.log('Dump created successfully:', {
          file: result.dumpFile,
          tables: result.totalTables,
          records: result.totalRecords,
          duration: `${result.duration}ms`
        });
      } else {
        console.error('Dump creation failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Dump creation failed:', error);
      process.exit(1);
    }
  });

program
  .command('dump-restore <filename>')
  .description('Restore from a dump file')
  .action(async (filename: string) => {
    try {
      const dumpService = DumpService.getInstance();
      const dumpFile = require('path').join(__dirname, '..', 'dumps', filename);
      const result = await dumpService.restoreFromDump(dumpFile);
      
      if (result.success) {
        console.log('Restore completed successfully:', {
          tables: result.totalTables,
          records: result.totalRecords,
          duration: `${result.duration}ms`
        });
      } else {
        console.error('Restore failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Restore failed:', error);
      process.exit(1);
    }
  });

program
  .command('dump-list')
  .description('List available dump files')
  .action(async () => {
    try {
      const dumpService = DumpService.getInstance();
      const dumps = await dumpService.listDumps();
      
      if (dumps.length === 0) {
        console.log('No dump files found');
      } else {
        console.log('Available dumps:', dumps);
      }
    } catch (error) {
      logger.error('Failed to list dumps:', error);
      process.exit(1);
    }
  });

program
  .command('dump-cleanup [days]')
  .description('Clean up old dump files (default: 7 days)')
  .action(async (days = '7') => {
    try {
      const dumpService = DumpService.getInstance();
      const deletedCount = await dumpService.cleanupOldDumps(parseInt(days));
      console.log(`Cleanup completed: deleted ${deletedCount} old dump files`);
    } catch (error) {
      logger.error('Cleanup failed:', error);
      process.exit(1);
    }
  });


program
  .command('query <sql>')
  .description('Execute SQL query on DuckDB')
  .action(async (sql: string) => {
    try {
      const duckdb = DuckDBConnection.getInstance();
      const result = await duckdb.query(sql);
      console.log('Query result:', JSON.stringify(result, null, 2));
    } catch (error) {
      logger.error('Query failed:', error);
      process.exit(1);
    }
  });

program.parse();

export default program;