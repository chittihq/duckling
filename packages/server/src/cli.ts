#!/usr/bin/env node

import { program } from 'commander';
import MySQLConnection from './database/mysql';
import ClickHouseConnection from './database/clickhouse';
import ClickHouseSyncService from './services/clickhouseSyncService';
import { DatabaseConfigManager } from './database/databaseConfig';
import logger from './logger';

// Helper function to get database connections
async function getDatabaseConnections(databaseId?: string): Promise<{ databaseId: string; mysql: MySQLConnection; clickhouse: ClickHouseConnection }> {
  const dbManager = DatabaseConfigManager.getInstance();

  // Use provided database ID or default to first database
  const databases = dbManager.getAllDatabases();
  if (databases.length === 0) {
    throw new Error('No databases configured. Please add a database first.');
  }

  const targetDbId = databaseId || databases[0].id;
  const dbConfig = dbManager.getDatabase(targetDbId);

  if (!dbConfig) {
    throw new Error(`Database '${targetDbId}' not found`);
  }

  const mysql = MySQLConnection.getInstance(dbConfig.id, dbConfig.mysqlConnectionString);
  const clickhouse = ClickHouseConnection.getInstance(
    dbConfig.id,
    dbConfig.clickhouseDatabase || dbConfig.id,
  );
  await clickhouse.initializeDatabase();

  return { databaseId: dbConfig.id, mysql, clickhouse };
}

function exitNotImplemented(feature: string): never {
  console.error(`${feature} is not implemented for the ClickHouse migration yet.`);
  process.exit(1);
}

program
  .name('clickhouse-sync')
  .description('ClickHouse MySQL Replication CLI')
  .version('1.0.0')
  .option('-d, --database <id>', 'Database ID to operate on (defaults to first database)')
  .option('-e, --engine <engine>', 'Query engine for ad hoc query command (clickhouse or mysql)', 'clickhouse');

program
  .command('sync')
  .description('Run full synchronization')
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);
      console.log(`Syncing database: ${databaseId}`);
      const syncService = ClickHouseSyncService.getInstance(databaseId, mysql, clickhouse);
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
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);
      console.log(`Syncing database: ${databaseId}`);
      const syncService = ClickHouseSyncService.getInstance(databaseId, mysql, clickhouse);
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
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);
      const syncService = ClickHouseSyncService.getInstance(databaseId, mysql, clickhouse);
      const status = await syncService.getSyncStatus();
      console.log(`Status for database: ${databaseId}`);
      console.log(JSON.stringify(status, null, 2));
    } catch (error) {
      logger.error('Failed to get status:', error);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate sync integrity')
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);
      const syncService = ClickHouseSyncService.getInstance(databaseId, mysql, clickhouse);
      const validation = await syncService.validateSync();
      console.log(`Validation for database: ${databaseId}`);
      console.log(JSON.stringify(validation, null, 2));
    } catch (error) {
      logger.error('Validation failed:', error);
      process.exit(1);
    }
  });

program
  .command('health')
  .description('Check database connections')
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);

      const mysqlHealthy = await mysql.testConnection();
      const clickhouseHealthy = await clickhouse.testConnection();

      console.log(`Health check for database: ${databaseId}`);
      console.log({
        mysql: mysqlHealthy ? 'healthy' : 'unhealthy',
        clickhouse: clickhouseHealthy ? 'healthy' : 'unhealthy',
      });

      if (!mysqlHealthy || !clickhouseHealthy) {
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
  .action(async (options, command) => {
    try {
      const { databaseId, mysql, clickhouse } = await getDatabaseConnections(command.parent.opts().database);

      const mysqlTables = await mysql.getTables();
      const clickhouseTables = await clickhouse.getTables();

      console.log(`Tables comparison for database: ${databaseId}`);
      console.log({
        mysql: mysqlTables,
        clickhouse: clickhouseTables,
        missing: mysqlTables.filter(t => !clickhouseTables.includes(t))
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
    exitNotImplemented('dump-create');
  });

program
  .command('dump-restore <filename>')
  .description('Restore from a dump file')
  .action(async () => {
    exitNotImplemented('dump-restore');
  });

program
  .command('dump-list')
  .description('List available dump files')
  .action(async () => {
    exitNotImplemented('dump-list');
  });

program
  .command('dump-cleanup [days]')
  .description('Clean up old dump files (default: 7 days)')
  .action(async () => {
    exitNotImplemented('dump-cleanup');
  });


program
  .command('query <sql>')
  .description('Execute SQL query on ClickHouse or MySQL')
  .action(async (sql: string, command) => {
    try {
      const parentOptions = command.parent?.opts() || {};
      const engine = parentOptions.engine || 'clickhouse';
      const databaseId = parentOptions.database;

      const { databaseId: resolvedDatabaseId, mysql, clickhouse } = await getDatabaseConnections(databaseId);
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(resolvedDatabaseId);

      let result: any[];
      if (engine === 'mysql') {
        result = await mysql.execute(sql);
      } else {
        result = await clickhouse.query(sql);
      }

      console.log('Query result:', JSON.stringify(result, null, 2));
    } catch (error) {
      logger.error('Query failed:', error);
      process.exit(1);
    }
  });

program.parse();

export default program;
