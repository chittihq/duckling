import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import DuckDBConnection from './database/duckdb';
import MySQLConnection from './database/mysql';
import SequentialAppenderService from './services/sequentialAppenderService';
import AutomationService from './services/automationService';
import CDCService from './services/cdcService';
import WebSocketService from './services/websocketService';
import LogBufferService from './services/logBufferService';
import { DatabaseConfigManager } from './database/databaseConfig';
import type { S3Config } from './database/databaseConfig';
import { attachDatabaseContext, RequestWithDatabase } from './middleware/database';
import s3BackupService from './services/s3BackupService';
import { diagnoseDatabase } from './services/diagnoseService';
import { generateToken, verifyToken, extractTokenFromHeader } from './utils/jwtUtils';
import { preAuthRateLimiter, postAuthRateLimiter, startRateLimitCleanup, stopRateLimitCleanup } from './middleware/rateLimit';
import config from './config';
import logger from './logger';

class InvalidIdentifierError extends Error {
  constructor(name: string) {
    super(`Invalid identifier: ${name}`);
    this.name = 'InvalidIdentifierError';
  }
}

/** Backtick-quote a MySQL identifier, escaping embedded backticks. */
function quoteMySQL(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Validate and double-quote a SQL identifier (table or column name). */
function q(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new InvalidIdentifierError(name);
  }
  // Reject null bytes and semicolons — everything else is safe inside double-quotes
  // as long as embedded double-quotes are escaped per SQL standard.
  if (/[\0;]/.test(name)) {
    throw new InvalidIdentifierError(name);
  }
  // Escape embedded double-quotes by doubling them (SQL standard)
  return `"${name.replace(/"/g, '""')}"`;
}

/** Send error response, using 400 for invalid identifier errors and 500 otherwise. */
function sendError(res: express.Response, error: unknown): void {
  if (error instanceof InvalidIdentifierError) {
    res.status(400).json({ error: error.message });
  } else {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Extend Express Request to include JWT user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
      };
    }
  }
}

class DuckDBServer {
  private app: express.Application;
  private server: http.Server;
  private websocketService: WebSocketService;
  private logBufferService: LogBufferService;

  constructor() {
    this.app = express();
    this.websocketService = WebSocketService.getInstance();
    this.logBufferService = LogBufferService.getInstance();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    if (config.server.enableCors) {
      this.app.use(cors({
        origin: true, // Allow requests from any origin in development
        credentials: true // Allow credentials (authorization headers)
      }));
    }

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // BigInt-safe JSON response middleware
    this.app.use((req, res, next) => {
      const originalJson = res.json;
      res.json = function(data: any) {
        return originalJson.call(this, JSON.parse(JSON.stringify(data, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )));
      };
      next();
    });

    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });

    // Sentry request context
    this.app.use((req, res, next) => {
      Sentry.setTag('http.method', req.method);
      Sentry.setTag('http.path', req.path);
      const dbId = req.query.db as string;
      if (dbId) Sentry.setTag('database.id', dbId);
      next();
    });

    // Pre-auth rate limiting (IP-based for auth + monitoring endpoints)
    this.app.use(preAuthRateLimiter);
    startRateLimitCleanup();
  }

  /**
   * Middleware to check for JWT or API key authentication (stateless)
   * Supports two authentication methods in priority order:
   * 1. API key (exact match)
   * 2. JWT token (verified and not expired)
   */
  private checkApiKeyOrSession(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required. Provide JWT token or API key in Authorization header.'
      });
      return;
    }

    const token = extractTokenFromHeader(authHeader);

    // Try API key first (exact match)
    if (config.auth.apiKey && token === config.auth.apiKey) {
      req.user = { username: 'api-key-user' };
      next();
      return;
    }

    // Try JWT verification
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = { username: decoded.username };
      next();
      return;
    }

    // Token provided but invalid
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }

  private setupRoutes(): void {
    // Authentication routes (public - no auth required)
    this.app.post('/api/login', this.login.bind(this));
    this.app.post('/api/logout', this.logout.bind(this));
    this.app.get('/api/check-auth', this.checkAuth.bind(this));

    // Serve OpenAPI spec (public)
    this.app.get('/openapi.json', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'openapi.json'));
    });

    // Global authentication middleware - protects API and operational routes
    this.app.use((req, res, next) => {
      const publicPaths = ['/api/login', '/api/check-auth', '/openapi.json'];
      if (publicPaths.includes(req.path)) {
        return next();
      }

      const protectedPrefixes = ['/api/', '/sync/', '/automation/', '/cdc/', '/metrics'];
      const requiresAuth = protectedPrefixes.some(p =>
        p.endsWith('/') ? req.path.startsWith(p) : req.path === p
      ) || req.path === '/health' || req.path === '/status';

      if (requiresAuth) {
        return this.checkApiKeyOrSession(req, res, next);
      }

      // Allow non-protected routes (frontend SPA, static assets)
      next();
    });

    // Post-auth rate limiting (identity-based for read/query/write endpoints)
    this.app.use(postAuthRateLimiter);

    // Protected API endpoints (require authentication via JWT, API key, or session)

    // Logs API endpoints
    this.app.get('/api/logs', this.getLogs.bind(this));
    this.app.get('/api/sync-logs', attachDatabaseContext, this.getSyncLogs.bind(this));

    // Database management endpoints
    this.app.get('/api/databases', this.getDatabases.bind(this));
    this.app.post('/api/databases', this.addDatabase.bind(this));
    this.app.put('/api/databases/:id', this.updateDatabase.bind(this));
    this.app.delete('/api/databases/:id', this.deleteDatabase.bind(this));
    this.app.post('/api/databases/:id/test', this.testDatabaseConnection.bind(this));
    this.app.post('/api/databases/:id/diagnose', this.diagnoseDatabaseConnection.bind(this));

    // S3 config endpoints (per database by :id, no ?db= needed)
    this.app.get('/api/databases/:id/s3', this.getS3Config.bind(this));
    this.app.put('/api/databases/:id/s3', this.saveS3Config.bind(this));
    this.app.delete('/api/databases/:id/s3', this.deleteS3Config.bind(this));
    this.app.post('/api/databases/:id/s3/test', this.testS3Connection.bind(this));

    // Backup endpoints (use ?db= for database context)
    this.app.get('/api/backups', attachDatabaseContext, this.listBackups.bind(this));
    this.app.post('/api/backups/s3', attachDatabaseContext, this.triggerS3Backup.bind(this));
    this.app.post('/api/backups/s3/restore', attachDatabaseContext, this.restoreFromS3.bind(this));

    // Serve static files from Nuxt build output (production)
    const publicPath = path.join(__dirname, '..', 'public');
    this.app.use(express.static(publicPath));

    // Health and status endpoints (protected, with database context)
    this.app.get('/health', attachDatabaseContext, this.healthCheck.bind(this));
    this.app.get('/status', attachDatabaseContext, this.getStatus.bind(this));

    // Synchronization endpoints (with database context)
    this.app.post('/sync/full', attachDatabaseContext, this.fullSync.bind(this));
    this.app.post('/sync/incremental', attachDatabaseContext, this.incrementalSync.bind(this));
    this.app.post('/sync/table/:tableName', attachDatabaseContext, this.syncSingleTable.bind(this));
    this.app.get('/sync/status', attachDatabaseContext, this.getSyncStatus.bind(this));
    this.app.get('/sync/validate', attachDatabaseContext, this.validateSync.bind(this));
    this.app.delete('/sync/clear-all', attachDatabaseContext, this.clearAllData.bind(this));

    // Automation & Recovery endpoints (with database context)
    this.app.get('/automation/status', attachDatabaseContext, this.getAutomationStatus.bind(this));
    this.app.post('/automation/start', attachDatabaseContext, this.startAutomation.bind(this));
    this.app.post('/automation/stop', attachDatabaseContext, this.stopAutomation.bind(this));
    this.app.post('/automation/backup', attachDatabaseContext, this.manualBackup.bind(this));
    this.app.post('/automation/restore', attachDatabaseContext, this.restoreFromBackup.bind(this));
    this.app.post('/automation/cleanup', attachDatabaseContext, this.manualCleanup.bind(this));

    // CDC (Change Data Capture) endpoints (with database context)
    this.app.get('/cdc/status', attachDatabaseContext, this.getCDCStatus.bind(this));
    this.app.post('/cdc/start', attachDatabaseContext, this.startCDC.bind(this));
    this.app.post('/cdc/stop', attachDatabaseContext, this.stopCDC.bind(this));
    this.app.post('/cdc/reset-stats', attachDatabaseContext, this.resetCDCStats.bind(this));

    // Data access endpoints (with database context)
    this.app.post('/api/query', attachDatabaseContext, this.executeQuery.bind(this));
    this.app.get('/api/tables', attachDatabaseContext, this.getTables.bind(this));
    this.app.get('/api/tables/counts/all', attachDatabaseContext, this.getAllTableCounts.bind(this));
    this.app.get('/api/tables/:name/schema', attachDatabaseContext, this.getTableSchema.bind(this));
    this.app.get('/api/tables/:name/data', attachDatabaseContext, this.getTableData.bind(this));
    this.app.get('/api/tables/:name/count', attachDatabaseContext, this.getTableRowCount.bind(this));

    // Enhanced metrics endpoint
    this.app.get('/metrics', this.getMetrics.bind(this));

    // Validation endpoints
    this.app.get('/api/validation/mysql-tables', attachDatabaseContext, this.getMySQLTables.bind(this));
    this.app.post('/api/validation/table-details', attachDatabaseContext, this.getTableValidationDetails.bind(this));
    this.app.delete('/api/validation/table/:tableName', attachDatabaseContext, this.deleteTableFromDuckDB.bind(this));

    // SPA catch-all route - serve index.html for all non-API routes (production)
    // This enables client-side routing for Nuxt (/login, /tables, etc.)
    this.app.get('*', (req, res) => {
      // Only serve index.html if it's not an API route
      if (!req.path.startsWith('/api/') && !req.path.startsWith('/_nuxt/')) {
        const indexPath = path.join(__dirname, '..', 'public', 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          // In development, Nuxt runs separately, so just return 404
          res.status(404).json({ error: 'Not found' });
        }
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });

    Sentry.setupExpressErrorHandler(this.app);
    this.app.use(this.errorHandler.bind(this));
  }

  private async healthCheck(req: express.Request, res: express.Response): Promise<void> {
    try {
      const dbManager = DatabaseConfigManager.getInstance();
      const allDatabases = dbManager.getAllDatabases();

      // Check health of all databases
      const databaseHealthChecks = await Promise.all(
        allDatabases.map(async (dbConfig) => {
          try {
            // Resolve duckdbPath
            let resolvedDuckdbPath = dbConfig.duckdbPath;
            if (resolvedDuckdbPath.startsWith('data/')) {
              resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
            }

            const mysql = MySQLConnection.getInstance(dbConfig.id, dbConfig.mysqlConnectionString);
            const duckdb = DuckDBConnection.getInstance(dbConfig.id, resolvedDuckdbPath);

            const mysqlHealthy = await mysql.testConnection();
            const duckdbHealthy = await duckdb.testConnection();

            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              status: mysqlHealthy && duckdbHealthy ? 'healthy' : 'unhealthy',
              services: {
                mysql: mysqlHealthy ? 'healthy' : 'unhealthy',
                duckdb: duckdbHealthy ? 'healthy' : 'unhealthy'
              }
            };
          } catch (error) {
            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              status: 'unhealthy',
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );

      // Overall status is healthy only if ALL databases are healthy
      const overallStatus = databaseHealthChecks.every((db) => db.status === 'healthy') ? 'healthy' : 'unhealthy';

      const health = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        databases: databaseHealthChecks,
        architecture: 'sequential-appender',
        features: ['atomic-transactions', 'watermark-sync', 'streaming-batches', 'acid-compliance', 'multi-database']
      };

      res.status(health.status === 'healthy' ? 200 : 503).json(health);
    } catch (error) {
      logger.error('Health check failed:', error);
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        architecture: 'sequential-appender'
      });
    }
  }

  private async getStatus(req: express.Request, res: express.Response): Promise<void> {
    try {
      const dbManager = DatabaseConfigManager.getInstance();
      const allDatabases = dbManager.getAllDatabases();

      // Get status for all databases
      const databaseStatuses = await Promise.all(
        allDatabases.map(async (dbConfig) => {
          try {
            // Resolve duckdbPath
            let resolvedDuckdbPath = dbConfig.duckdbPath;
            if (resolvedDuckdbPath.startsWith('data/')) {
              resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
            }

            const mysql = MySQLConnection.getInstance(dbConfig.id, dbConfig.mysqlConnectionString);
            const duckdb = DuckDBConnection.getInstance(dbConfig.id, resolvedDuckdbPath);

            const mysqlTables = await mysql.getTables();
            const duckdbTables = await duckdb.getTables();

            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              tables: {
                mysql: mysqlTables.length,
                duckdb: duckdbTables.length
              }
            };
          } catch (error) {
            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );

      const status = {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        architecture: 'sequential-appender',
        config: {
          syncInterval: config.sync.intervalMinutes,
          batchSize: config.sync.batchSize,
          incrementalSync: config.sync.enableIncremental
        },
        databases: databaseStatuses
      };

      res.json(status);
    } catch (error) {
      logger.error('Status check failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Synchronization endpoints
  private async fullSync(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const result = await syncService.fullSync();
      res.json(result);
    } catch (error) {
      logger.error('Full sync failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async incrementalSync(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const result = await syncService.incrementalSync();
      res.json(result);
    } catch (error) {
      logger.error('Incremental sync failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async syncSingleTable(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { tableName } = req.params;
      q(tableName); // validate
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const result = await syncService.syncSingleTable(tableName);
      res.json(result);
    } catch (error) {
      logger.error(`Single table sync failed for ${req.params.tableName}:`, error);
      sendError(res, error);
    }
  }

  private async getSyncStatus(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const status = await syncService.getSyncStatus();
      res.json(this.serializeBigInt(status));
    } catch (error) {
      logger.error('Get sync status failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async validateSync(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const validation = await syncService.validateSync();
      res.json(validation);
    } catch (error) {
      logger.error('Sync validation failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Data management endpoint
  private async clearAllData(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { duckdb, databaseId } = req as RequestWithDatabase;
      logger.info(`Starting clear all data operation for database: ${databaseId}`);

      // Get tables to drop
      const tables = await duckdb.getTables();

      // Drop all tables
      for (const table of tables) {
        try {
          await duckdb.run(`DROP TABLE IF EXISTS ${q(table)}`);
        } catch (error) {
          logger.warn(`Failed to drop table ${table}:`, error);
        }
      }

      // Reinitialize database (watermark table, etc.)
      logger.info('Reinitializing database after clear');
      try {
        await duckdb.initializeDatabase();
        logger.info('Database reinitialized successfully');
      } catch (error) {
        logger.error('Failed to reinitialize database:', error);
        throw new Error('Failed to reinitialize database after clear');
      }

      logger.info(`Clear all data completed: ${tables.length} tables dropped`);

      res.json({
        success: true,
        message: 'All DuckDB data cleared successfully. Database reinitialized.',
        tablesDropped: tables.length
      });
    } catch (error) {
      logger.error('Clear all data failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Data access endpoints
  private async executeQuery(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { mysql, duckdb, databaseId } = req as RequestWithDatabase;
      const { sql, params, database = 'duckdb' } = req.body;

      if (!sql) {
        res.status(400).json({ error: 'SQL query is required' });
        return;
      }

      // Validate database parameter
      if (!['duckdb', 'mysql'].includes(database)) {
        res.status(400).json({ error: 'Invalid database. Must be "duckdb" or "mysql"' });
        return;
      }

      let result: any[];

      // Execute query on selected database
      // lgtm[js/sql-injection] - intentional query execution endpoint, protected by authentication
      if (database === 'mysql') {
        result = await mysql.execute(sql, params);
      } else {
        result = await duckdb.query(sql, params);
      }

      // Convert BigInt values to strings for JSON serialization
      // Both DuckDB and MySQL now return objects with column names
      const serializedResult = result.map((row: any) => {
        const serializedRow: any = {};
        for (const [key, value] of Object.entries(row)) {
          if (typeof value === 'bigint') {
            serializedRow[key] = value.toString();
          } else {
            serializedRow[key] = value;
          }
        }
        return serializedRow;
      });

      res.json({
        result: serializedResult,
        database,
        architecture: database === 'duckdb' ? 'sequential-appender' : 'mysql'
      });
    } catch (error) {
      logger.error('Query execution failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getTables(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { duckdb } = req as RequestWithDatabase;
      const tables = await duckdb.getTables();
      res.json(tables);
    } catch (error) {
      logger.error('Get tables failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getTableSchema(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { name } = req.params;
      const { duckdb } = req as RequestWithDatabase;
      const result = await duckdb.execute(`DESCRIBE ${q(name)}`);

      // After executeRaw conversion, DESCRIBE returns objects with column_name, column_type, etc.
      // Use bracket notation for reserved keywords (null, default)
      const columns = result.map((row: any) => ({
        column_name: row.column_name,
        column_type: row.column_type,
        null: row['null'],
        key: row.key,
        default_value: row['default'],
        extra: row.extra
      }));

      res.json({ columns });
    } catch (error) {
      logger.error('Get table schema failed:', error);
      sendError(res, error);
    }
  }

  private async getTableData(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { name } = req.params;
      const { duckdb } = req as RequestWithDatabase;
      const { limit = 100, offset = 0 } = req.query;

      // Build query with LIMIT and OFFSET to prevent loading too much data
      const safeName = q(name);
      const safeLimit = Math.max(1, Math.min(10000, parseInt(limit.toString()) || 100));
      const safeOffset = Math.max(0, parseInt(offset.toString()) || 0);
      let query = `SELECT * FROM ${safeName} LIMIT ${safeLimit} OFFSET ${safeOffset}`;

      const data = await duckdb.execute(query);

      // Convert BigInt values to strings for JSON serialization
      // After executeRaw conversion, both DuckDB and MySQL return objects with column names
      const serializedData = data.map((row: any) => {
        const serializedRow: any = {};
        for (const [key, value] of Object.entries(row)) {
          if (typeof value === 'bigint') {
            serializedRow[key] = value.toString();
          } else {
            serializedRow[key] = value;
          }
        }
        return serializedRow;
      });

      res.json(serializedData);
    } catch (error) {
      logger.error('Get table data failed:', error);
      sendError(res, error);
    }
  }

  private async getAllTableCounts(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { duckdb } = req as RequestWithDatabase;
      const tables = await duckdb.getTables();
      const counts: Record<string, number> = {};

      // Get all counts in parallel
      await Promise.all(
        tables.map(async (tableName) => {
          try {
            const count = await duckdb.getTableRowCount(tableName);
            counts[tableName] = typeof count === 'bigint' ? Number(count) : count;
          } catch (error) {
            logger.warn(`Failed to get count for ${tableName}:`, error);
            counts[tableName] = 0;
          }
        })
      );

      res.json(counts);
    } catch (error) {
      logger.error('Get all table counts failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getTableRowCount(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { name } = req.params;
      q(name); // validate
      const { duckdb } = req as RequestWithDatabase;
      const count = await duckdb.getTableRowCount(name);
      // Convert BigInt to number for JSON serialization
      const serializedCount = typeof count === 'bigint' ? Number(count) : count;
      res.json({ count: serializedCount });
    } catch (error) {
      logger.error('Get table row count failed:', error);
      sendError(res, error);
    }
  }

  // Enhanced metrics - returns metrics for all databases
  private async getMetrics(req: express.Request, res: express.Response): Promise<void> {
    try {
      const dbManager = DatabaseConfigManager.getInstance();
      const allDatabases = dbManager.getAllDatabases();

      // Get metrics for all databases
      const databaseMetrics = await Promise.all(
        allDatabases.map(async (dbConfig) => {
          try {
            // Resolve duckdbPath
            let resolvedDuckdbPath = dbConfig.duckdbPath;
            if (resolvedDuckdbPath.startsWith('data/')) {
              resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
            }

            const mysql = MySQLConnection.getInstance(dbConfig.id, dbConfig.mysqlConnectionString);
            const duckdb = DuckDBConnection.getInstance(dbConfig.id, resolvedDuckdbPath);
            const syncService = SequentialAppenderService.getInstance(dbConfig.id, mysql, duckdb);

            const status = await syncService.getSyncStatus();

            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              ...status
            };
          } catch (error) {
            return {
              databaseId: dbConfig.id,
              name: dbConfig.name,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );

      res.json(this.serializeBigInt({
        databases: databaseMetrics,
        architecture: 'sequential-appender',
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      logger.error('Get metrics failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private serializeBigInt(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    // Handle Date objects
    if (obj instanceof Date) {
      return obj.toISOString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInt(item));
    }

    if (typeof obj === 'object') {
      const serialized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        serialized[key] = this.serializeBigInt(value);
      }
      return serialized;
    }

    return obj;
  }

  // Automation & Recovery endpoint handlers
  private async getAutomationStatus(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      const status = automationService.getStatus();
      res.json({
        success: true,
        status,
        architecture: 'sequential-appender'
      });
    } catch (error) {
      logger.error('Get automation status failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async startAutomation(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      await automationService.start();
      res.json({
        success: true,
        message: 'Automation service started successfully'
      });
    } catch (error) {
      logger.error('Start automation failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async stopAutomation(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      automationService.stop();
      res.json({
        success: true,
        message: 'Automation service stopped successfully'
      });
    } catch (error) {
      logger.error('Stop automation failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async manualBackup(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      // Trigger manual backup via automation service
      await automationService.performBackup();
      res.json({
        success: true,
        message: 'Manual backup completed successfully'
      });
    } catch (error) {
      logger.error('Manual backup failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async restoreFromBackup(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      await automationService.restoreFromLatestBackup();
      res.json({
        success: true,
        message: 'Restore from backup completed successfully'
      });
    } catch (error) {
      logger.error('Restore from backup failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async manualCleanup(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      // Trigger manual cleanup via automation service
      await automationService.performCleanup();
      res.json({
        success: true,
        message: 'Manual cleanup completed successfully'
      });
    } catch (error) {
      logger.error('Manual cleanup failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // CDC (Change Data Capture) endpoint handlers
  private async getCDCStatus(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const cdcService = CDCService.getInstance(databaseId);

      if (!cdcService) {
        res.json({
          success: true,
          status: {
            isRunning: false,
            message: 'CDC service not initialized for this database'
          },
          enabled: config.cdc.enabled
        });
        return;
      }

      const stats = cdcService.getStats();
      res.json({
        success: true,
        status: stats,
        enabled: config.cdc.enabled
      });
    } catch (error) {
      logger.error('Get CDC status failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async startCDC(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(databaseId);

      if (!dbConfig) {
        res.status(404).json({
          success: false,
          error: `Database '${databaseId}' not found`
        });
        return;
      }

      if (!dbConfig.mysqlConnectionString) {
        res.status(400).json({
          success: false,
          error: 'MySQL connection string not configured for this database'
        });
        return;
      }

      // Parse connection string and create CDC config
      const cdcConfig = CDCService.parseConnectionString(dbConfig.mysqlConnectionString, databaseId);

      // Add exclude tables from sync config
      cdcConfig.excludeTables = config.sync.excludedTables;

      // Create and start CDC service
      const cdcService = await CDCService.createInstance(cdcConfig);
      await cdcService.start();

      res.json({
        success: true,
        message: `CDC service started for database '${databaseId}'`,
        status: cdcService.getStats()
      });
    } catch (error) {
      logger.error('Start CDC failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async stopCDC(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const cdcService = CDCService.getInstance(databaseId);

      if (!cdcService) {
        res.status(404).json({
          success: false,
          error: `CDC service not running for database '${databaseId}'`
        });
        return;
      }

      await cdcService.stop();

      res.json({
        success: true,
        message: `CDC service stopped for database '${databaseId}'`
      });
    } catch (error) {
      logger.error('Stop CDC failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async resetCDCStats(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const cdcService = CDCService.getInstance(databaseId);

      if (!cdcService) {
        res.status(404).json({
          success: false,
          error: `CDC service not running for database '${databaseId}'`
        });
        return;
      }

      cdcService.resetStats();

      res.json({
        success: true,
        message: `CDC stats reset for database '${databaseId}'`,
        status: cdcService.getStats()
      });
    } catch (error) {
      logger.error('Reset CDC stats failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Authentication endpoint handlers
  private async login(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        res.status(400).json({
          success: false,
          message: 'Username and password are required'
        });
        return;
      }

      if (username === config.auth.adminUsername && password === config.auth.adminPassword) {
        // Generate JWT token (stateless authentication)
        const token = generateToken(username);

        res.json({
          success: true,
          message: 'Login successful',
          username,
          token,
          expiresIn: config.auth.jwtExpiresIn
        });
      } else {
        res.status(401).json({
          success: false,
          message: 'Invalid username or password'
        });
      }
    } catch (error) {
      logger.error('Login failed:', error);
      res.status(500).json({
        success: false,
        message: 'Login failed'
      });
    }
  }

  private async logout(req: express.Request, res: express.Response): Promise<void> {
    try {
      // JWT is stateless - logout is handled client-side by discarding the token
      // This endpoint exists for API compatibility
      res.json({
        success: true,
        message: 'Logout successful. Please discard your JWT token on the client side.'
      });
    } catch (error) {
      logger.error('Logout failed:', error);
      res.status(500).json({
        success: false,
        message: 'Logout failed'
      });
    }
  }

  private async checkAuth(req: express.Request, res: express.Response): Promise<void> {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        res.json({
          authenticated: false,
          message: 'No authorization header provided'
        });
        return;
      }

      const token = extractTokenFromHeader(authHeader);

      // Check if it's an API key
      if (config.auth.apiKey && token === config.auth.apiKey) {
        res.json({
          authenticated: true,
          username: 'api-key-user',
          authMethod: 'api-key'
        });
        return;
      }

      // Check JWT token
      const decoded = verifyToken(token);
      if (decoded) {
        res.json({
          authenticated: true,
          username: decoded.username,
          authMethod: 'jwt'
        });
        return;
      }

      // Invalid token
      res.json({
        authenticated: false,
        message: 'Invalid or expired token'
      });
    } catch (error) {
      logger.error('Check auth failed:', error);
      res.status(500).json({
        authenticated: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Helper function to sanitize database config by removing sensitive fields
   */
  private sanitizeDatabaseConfig(dbConfig: any): any {
    const { mysqlConnectionString, s3, ...sanitized } = dbConfig;
    if (s3) {
      sanitized.s3 = {
        ...s3,
        secretAccessKey: s3.secretAccessKey ? '***' : undefined,
        encryptionKey: s3.encryptionKey ? '***' : undefined,
      };
    }
    return sanitized;
  }

  // Database management handlers
  private async getDatabases(req: express.Request, res: express.Response): Promise<void> {
    try {
      const dbManager = DatabaseConfigManager.getInstance();
      const databases = dbManager.getAllDatabases();
      // Remove MySQL connection strings from response (security)
      const sanitizedDatabases = databases.map(db => this.sanitizeDatabaseConfig(db));
      res.json({ success: true, databases: sanitizedDatabases });
    } catch (error) {
      logger.error('Get databases failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async addDatabase(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { name, mysqlConnectionString } = req.body;
      if (!name || !mysqlConnectionString) {
        res.status(400).json({
          success: false,
          error: 'Name and MySQL connection string are required'
        });
        return;
      }

      const dbManager = DatabaseConfigManager.getInstance();
      const newDb = dbManager.addDatabase({ name, mysqlConnectionString });

      // Remove MySQL connection string from response (security)
      res.json({ success: true, database: this.sanitizeDatabaseConfig(newDb) });
    } catch (error) {
      logger.error('Add database failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async updateDatabase(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body;

      const dbManager = DatabaseConfigManager.getInstance();
      const updated = dbManager.updateDatabase(id, updates);

      if (!updated) {
        res.status(404).json({
          success: false,
          error: 'Database not found'
        });
        return;
      }

      // Remove MySQL connection string from response (security)
      res.json({ success: true, database: this.sanitizeDatabaseConfig(updated) });
    } catch (error) {
      logger.error('Update database failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async deleteDatabase(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;

      const dbManager = DatabaseConfigManager.getInstance();
      const deleted = dbManager.deleteDatabase(id);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Database not found'
        });
        return;
      }

      // Close the DuckDB connection for this database
      DuckDBConnection.closeInstance(id);

      res.json({ success: true, message: 'Database deleted successfully' });
    } catch (error) {
      logger.error('Delete database failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async testDatabaseConnection(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbManager = DatabaseConfigManager.getInstance();
      const dbConfig = dbManager.getDatabase(id);

      if (!dbConfig) {
        res.status(404).json({
          success: false,
          error: 'Database not found'
        });
        return;
      }

      // Test MySQL connection
      const mysqlConn = new MySQLConnection(dbConfig.mysqlConnectionString);
      const mysqlHealthy = await mysqlConn.testConnection();
      await mysqlConn.close();

      // Test DuckDB connection
      const duckdbConn = DuckDBConnection.getInstance(id, dbConfig.duckdbPath);
      const duckdbHealthy = await duckdbConn.testConnection();

      res.json({
        success: true,
        connections: {
          mysql: mysqlHealthy ? 'healthy' : 'unhealthy',
          duckdb: duckdbHealthy ? 'healthy' : 'unhealthy'
        }
      });
    } catch (error) {
      logger.error('Test database connection failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async diagnoseDatabaseConnection(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbManager = DatabaseConfigManager.getInstance();
      const dbConfig = dbManager.getDatabase(id);

      if (!dbConfig) {
        res.status(404).json({ success: false, error: 'Database not found' });
        return;
      }

      const mysql = MySQLConnection.getInstance(id, dbConfig.mysqlConnectionString);
      const result = await diagnoseDatabase(mysql);
      res.json({ success: true, diagnosis: result });
    } catch (error) {
      logger.error('Diagnose database failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // S3 config handlers
  private async getS3Config(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(id);
      if (!dbConfig) {
        res.status(404).json({ success: false, error: 'Database not found' });
        return;
      }
      if (!dbConfig.s3) {
        res.json({ success: true, s3: null });
        return;
      }
      // Return config with credentials masked
      res.json({
        success: true,
        s3: {
          ...dbConfig.s3,
          secretAccessKey: '***',
          ...(dbConfig.s3.encryptionKey ? { encryptionKey: '***' } : {}),
        },
      });
    } catch (error) {
      logger.error('Get S3 config failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async saveS3Config(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbManager = DatabaseConfigManager.getInstance();
      const dbConfig = dbManager.getDatabase(id);
      if (!dbConfig) {
        res.status(404).json({ success: false, error: 'Database not found' });
        return;
      }

      const {
        enabled, bucket, region, accessKeyId, secretAccessKey,
        endpoint, forcePathStyle, pathPrefix,
        encryption, kmsKeyId, encryptionKey,
        s3BackupIntervalHours, s3BackupRetentionDays,
      } = req.body;

      if (!bucket || !region || !accessKeyId) {
        res.status(400).json({ success: false, error: 'bucket, region, and accessKeyId are required' });
        return;
      }

      const newS3: S3Config = {
        enabled: enabled !== false,
        bucket,
        region,
        accessKeyId,
        secretAccessKey: secretAccessKey || dbConfig.s3?.secretAccessKey || '',
        ...(endpoint ? { endpoint } : {}),
        ...(forcePathStyle ? { forcePathStyle: true } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(encryption ? { encryption } : {}),
        ...(kmsKeyId ? { kmsKeyId } : {}),
        // Preserve existing encryptionKey if not sending a new one (same pattern as secretAccessKey)
        ...(encryptionKey
          ? { encryptionKey }
          : dbConfig.s3?.encryptionKey
          ? { encryptionKey: dbConfig.s3.encryptionKey }
          : {}),
        ...(s3BackupIntervalHours > 0 ? { s3BackupIntervalHours: Number(s3BackupIntervalHours) } : {}),
        ...(s3BackupRetentionDays > 0 ? { s3BackupRetentionDays: Number(s3BackupRetentionDays) } : {}),
      };

      dbManager.updateDatabase(id, { s3: newS3 });

      // Restart the S3 backup schedule on the running automation instance if present
      await AutomationService.restartS3ScheduleIfRunning(id);

      res.json({ success: true, s3: { ...newS3, secretAccessKey: '***' } });
    } catch (error) {
      logger.error('Save S3 config failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async deleteS3Config(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbManager = DatabaseConfigManager.getInstance();
      const dbConfig = dbManager.getDatabase(id);
      if (!dbConfig) {
        res.status(404).json({ success: false, error: 'Database not found' });
        return;
      }
      dbManager.updateDatabase(id, { s3: undefined });
      res.json({ success: true, message: 'S3 configuration removed' });
    } catch (error) {
      logger.error('Delete S3 config failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async testS3Connection(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { id } = req.params;
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(id);
      if (!dbConfig?.s3) {
        res.status(400).json({ success: false, error: 'S3 not configured for this database' });
        return;
      }
      await s3BackupService.testConnection(dbConfig.s3);
      res.json({ success: true, message: 'S3 connection successful' });
    } catch (error) {
      logger.error('Test S3 connection failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  // Backup list / trigger / restore handlers
  private async listBackups(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const backups: any[] = [];

      // List local backups
      const backupDir = config.paths.backups;
      if (fs.existsSync(backupDir)) {
        const entries = fs.readdirSync(backupDir);
        for (const entry of entries) {
          const entryPath = path.join(backupDir, entry);
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory() && entry.startsWith('backup-')) {
            const dbFile = path.join(entryPath, 'duckling.db');
            const size = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
            backups.push({
              name: entry,
              location: 'local',
              size,
              lastModified: stat.mtime.toISOString(),
              key: entry,
            });
          }
        }
      }

      // List S3 backups if configured
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(databaseId);
      if (dbConfig?.s3?.enabled) {
        const s3Backups = await s3BackupService.listBackups(databaseId, dbConfig.s3);
        for (const b of s3Backups) {
          backups.push({
            name: path.basename(b.key),
            location: 's3',
            size: b.size,
            lastModified: b.lastModified.toISOString(),
            key: b.key,
          });
        }
      }

      backups.sort(
        (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
      );

      res.json({ success: true, backups });
    } catch (error) {
      logger.error('List backups failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async triggerS3Backup(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId } = req as RequestWithDatabase;
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(databaseId);
      if (!dbConfig?.s3?.enabled) {
        res.status(400).json({ success: false, error: 'S3 not configured or not enabled for this database' });
        return;
      }

      const resolvedDuckdbPath = dbConfig.duckdbPath.startsWith('data/')
        ? `/app/${dbConfig.duckdbPath}`
        : dbConfig.duckdbPath;

      if (!fs.existsSync(resolvedDuckdbPath)) {
        res.status(400).json({ success: false, error: 'DuckDB file not found' });
        return;
      }

      const key = await s3BackupService.uploadBackup(databaseId, resolvedDuckdbPath, dbConfig.s3);
      res.json({ success: true, key, message: `Backup uploaded to S3: ${key}` });
    } catch (error) {
      logger.error('Trigger S3 backup failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async restoreFromS3(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const { key } = req.body;
      if (!key) {
        res.status(400).json({ success: false, error: 'Backup key is required' });
        return;
      }

      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const automationService = AutomationService.getInstance(databaseId, syncService, duckdb, mysql);
      await automationService.restoreFromS3Backup(key);
      res.json({ success: true, message: 'Database restored from S3 backup successfully' });
    } catch (error) {
      logger.error('Restore from S3 failed:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  // Validation endpoint handlers
  private async getMySQLTables(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { mysql } = req as RequestWithDatabase;
      const tables = await mysql.getAllTables();
      res.json(tables);
    } catch (error) {
      logger.error('Get MySQL tables failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getTableValidationDetails(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { mysql, duckdb } = req as RequestWithDatabase;
      const { tableName, skipMySQLCount } = req.body;

      if (!tableName) {
        res.status(400).json({ error: 'Table name is required' });
        return;
      }

      const safeTableName = q(tableName); // validate before use in queries

      // Check DuckDB
      let duckdbExists = false;
      let duckdbColumnCount = 0;
      let duckdbRecordCount = 0;
      let duckdbColumns: string[] = [];

      try {
        const duckdbTables = await duckdb.getTables();
        duckdbExists = duckdbTables.includes(tableName);

        if (duckdbExists) {
          // Get column count and names
          const schema = await duckdb.execute(`DESCRIBE ${safeTableName}`);
          duckdbColumnCount = schema.length;
          // After executeRaw conversion, DESCRIBE returns objects with column_name property
          duckdbColumns = schema.map((col: any) => col.column_name);

          // Get record count
          const countResult = await duckdb.getTableRowCount(tableName);
          duckdbRecordCount = typeof countResult === 'bigint' ? Number(countResult) : countResult;
        }
      } catch (error) {
        logger.warn(`Failed to get DuckDB details for ${tableName}:`, error);
      }

      // Check MySQL
      let mysqlExists = false;
      let mysqlColumnCount = 0;
      let mysqlRecordCount: number | null = null; // null means "not counted yet"
      let mysqlColumns: string[] = [];
      let mysqlSchema: any[] = [];

      try {
        const mysqlTables = await mysql.getAllTables();
        mysqlExists = mysqlTables.includes(tableName);

        if (mysqlExists) {
          // Get column count and names (fast - uses DESCRIBE)
          mysqlSchema = await mysql.getTableSchema(tableName);
          mysqlColumnCount = mysqlSchema.length;
          mysqlColumns = mysqlSchema.map((col: any) => col.Field);

          // Only count MySQL records if not skipped (COUNT(*) is slow for large tables)
          if (!skipMySQLCount) {
            const countResult = await mysql.getTableRowCount(tableName);
            mysqlRecordCount = typeof countResult === 'bigint' ? Number(countResult) : countResult;
          }
        }
      } catch (error) {
        logger.warn(`Failed to get MySQL details for ${tableName}:`, error);
      }

      // Check if columns match (allow DuckDB to have exactly 1 extra column for ingest_date)
      const columnsMatch =
        duckdbColumnCount === mysqlColumnCount ||
        duckdbColumnCount === mysqlColumnCount + 1;

      // Detect missing columns (columns in MySQL but not in DuckDB)
      const missingColumns = mysqlColumns.filter(col => !duckdbColumns.includes(col));
      const extraColumns = duckdbColumns.filter(col => !mysqlColumns.includes(col) && col !== 'ingest_date');

      // Detect primary key from MySQL schema
      const pkCol = mysqlSchema.find((col: any) => col.Key === 'PRI');
      const primaryKey: string | null = pkCol ? pkCol.Field : null;
      const numericTypes = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT'];
      const pkIsNumeric = pkCol ? numericTypes.some(t => (pkCol.Type as string).toUpperCase().includes(t)) : false;

      // Run max-ID and checksum queries when both tables exist and PK is detected
      let duckdbMaxId: string | null = null;
      let mysqlMaxId: string | null = null;
      let duckdbChecksum: string | null = null;
      let mysqlChecksum: string | null = null;

      if (duckdbExists && mysqlExists && primaryKey) {
        try {
          const safePK = q(primaryKey);
          // Build queries (MySQL uses backticks, DuckDB uses double-quotes)
          const maxIdPromises: Promise<any>[] = [
            mysql.execute(`SELECT MAX(${quoteMySQL(primaryKey)}) as max_id FROM ${quoteMySQL(tableName)}`),
            duckdb.execute(`SELECT MAX(${safePK}) as max_id FROM ${safeTableName}`)
          ];

          // Add checksum queries for numeric PKs
          if (pkIsNumeric) {
            maxIdPromises.push(
              mysql.execute(`SELECT SUM(CAST(${quoteMySQL(primaryKey)} AS SIGNED)) as checksum FROM ${quoteMySQL(tableName)}`),
              duckdb.execute(`SELECT SUM(CAST(${safePK} AS BIGINT)) as checksum FROM ${safeTableName}`)
            );
          }

          const results = await Promise.all(maxIdPromises);

          // Extract max ID results (stringify to avoid BigInt precision issues)
          const mysqlMaxIdRow = results[0]?.[0];
          const duckdbMaxIdRow = results[1]?.[0];
          mysqlMaxId = mysqlMaxIdRow?.max_id != null ? String(mysqlMaxIdRow.max_id) : null;
          duckdbMaxId = duckdbMaxIdRow?.max_id != null ? String(duckdbMaxIdRow.max_id) : null;

          // Extract checksum results for numeric PKs
          if (pkIsNumeric) {
            const mysqlChecksumRow = results[2]?.[0];
            const duckdbChecksumRow = results[3]?.[0];
            mysqlChecksum = mysqlChecksumRow?.checksum != null ? String(mysqlChecksumRow.checksum) : null;
            duckdbChecksum = duckdbChecksumRow?.checksum != null ? String(duckdbChecksumRow.checksum) : null;
          }
        } catch (error) {
          logger.warn(`Failed to get max-ID/checksum for ${tableName}:`, error);
        }
      }

      // Determine error type (priority: schema > max_id > checksum > record_count)
      let errorType = null;
      let errorMessage = null;

      if (duckdbExists && mysqlExists) {
        if (missingColumns.length > 0) {
          errorType = 'schema_mismatch';
          errorMessage = `Missing columns in DuckDB: ${missingColumns.join(', ')}`;
        } else if (extraColumns.length > 0) {
          errorType = 'schema_mismatch';
          errorMessage = `Extra columns in DuckDB: ${extraColumns.join(', ')}`;
        } else if (primaryKey && duckdbMaxId !== mysqlMaxId) {
          errorType = 'max_id_mismatch';
          errorMessage = `Max ${primaryKey} mismatch: DuckDB (${duckdbMaxId}) vs MySQL (${mysqlMaxId})`;
        } else if (pkIsNumeric && duckdbChecksum !== mysqlChecksum) {
          errorType = 'checksum_mismatch';
          errorMessage = `Checksum SUM(${primaryKey}) mismatch: DuckDB (${duckdbChecksum}) vs MySQL (${mysqlChecksum})`;
        } else if (mysqlRecordCount !== null && duckdbRecordCount !== mysqlRecordCount) {
          // Only compare record counts if MySQL count is available
          errorType = 'record_count_mismatch';
          errorMessage = `Record count mismatch: DuckDB (${duckdbRecordCount}) vs MySQL (${mysqlRecordCount})`;
        }
      } else if (!duckdbExists && mysqlExists) {
        errorType = 'missing_in_duckdb';
        errorMessage = 'Table exists in MySQL but not in DuckDB';
      } else if (duckdbExists && !mysqlExists) {
        errorType = 'orphaned_in_duckdb';
        errorMessage = 'Table exists in DuckDB but not in MySQL';
      }

      res.json({
        primaryKey,
        duckdb: {
          exists: duckdbExists,
          columnCount: duckdbColumnCount,
          recordCount: duckdbRecordCount,
          columns: duckdbColumns,
          maxId: duckdbMaxId,
          checksum: duckdbChecksum
        },
        mysql: {
          exists: mysqlExists,
          columnCount: mysqlColumnCount,
          recordCount: mysqlRecordCount, // null if skipMySQLCount was true
          columns: mysqlColumns,
          maxId: mysqlMaxId,
          checksum: mysqlChecksum
        },
        columnsMatch,
        missingColumns,
        extraColumns,
        errorType,
        errorMessage,
        mysqlCountSkipped: skipMySQLCount === true
      });
    } catch (error) {
      logger.error('Get table validation details failed:', error);
      sendError(res, error);
    }
  }

  /**
   * Delete a table from DuckDB
   * Useful for handling schema changes - delete the table and let sync recreate it
   */
  private async deleteTableFromDuckDB(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { duckdb } = req as RequestWithDatabase;
      const { tableName } = req.params;

      if (!tableName) {
        res.status(400).json({ success: false, error: 'Table name is required' });
        return;
      }

      const safeTableName = q(tableName);

      // Check if table exists in DuckDB
      const duckdbTables = await duckdb.getTables();
      if (!duckdbTables.includes(tableName)) {
        res.status(404).json({
          success: false,
          error: `Table "${tableName}" does not exist in DuckDB`
        });
        return;
      }

      // Drop the table
      await duckdb.run(`DROP TABLE IF EXISTS ${safeTableName}`);
      logger.info(`Table "${tableName}" deleted from DuckDB`);

      // Also delete the watermark to ensure fresh sync
      try {
        await duckdb.run(`DELETE FROM appender_watermarks WHERE table_name = ?`, [tableName]);
        logger.info(`Watermark for "${tableName}" cleared`);
      } catch (error) {
        logger.warn(`Failed to clear watermark for ${tableName}:`, error);
      }

      res.json({
        success: true,
        message: `Table "${tableName}" deleted successfully from DuckDB. Next sync will recreate it with the latest schema.`
      });
    } catch (error) {
      logger.error(`Delete table failed for ${req.params.tableName}:`, error);
      if (error instanceof InvalidIdentifierError) {
        res.status(400).json({ success: false, error: error.message });
      } else {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  private errorHandler(err: Error, req: express.Request, res: express.Response, next: express.NextFunction): void {
    logger.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      architecture: 'sequential-appender'
    });
  }

  async start(): Promise<void> {
    try {
      console.log('Starting DuckDB Server...');

      // Debug: Log configuration values
      console.log('=== Configuration Debug ===');
      console.log(`BATCH_SIZE env var: ${process.env.BATCH_SIZE}`);
      console.log(`config.sync.batchSize: ${config.sync.batchSize}`);
      console.log(`config.sync.enableIncremental: ${config.sync.enableIncremental}`);
      console.log(`config.sync.intervalMinutes: ${config.sync.intervalMinutes}`);
      console.log('========================');

      // Initialize all databases in parallel for faster startup
      console.log('Initializing all databases in parallel...');
      const dbManager = DatabaseConfigManager.getInstance();
      const allDatabases = dbManager.getAllDatabases();

      // Create initialization promises for all databases
      const initPromises = allDatabases.map(async (dbConfig, i) => {
        try {
          console.log(`Initializing database: ${dbConfig.name} (${dbConfig.id})`);

          // Resolve duckdbPath
          let resolvedDuckdbPath = dbConfig.duckdbPath;
          if (resolvedDuckdbPath.startsWith('data/')) {
            resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
          }

          const mysql = MySQLConnection.getInstance(dbConfig.id, dbConfig.mysqlConnectionString);
          const duckdb = DuckDBConnection.getInstance(dbConfig.id, resolvedDuckdbPath);
          await duckdb.initializeDatabase();

          // Initialize sync and automation services for this database
          const syncService = SequentialAppenderService.getInstance(dbConfig.id, mysql, duckdb);
          const automationService = AutomationService.getInstance(dbConfig.id, syncService, duckdb, mysql);

          // Calculate staggered offset: each database gets 5 minutes offset from previous
          // This prevents multiple databases from syncing simultaneously
          const syncOffsetMs = i * 5 * 60 * 1000; // 5 minutes per database

          // Start automation service with staggered sync offset
          await automationService.start(syncOffsetMs);

          console.log(`✓ Database ${dbConfig.name} initialized successfully${syncOffsetMs > 0 ? ` (sync offset: ${syncOffsetMs / 1000 / 60}min)` : ''}`);
        } catch (error) {
          console.error(`✗ Failed to initialize database ${dbConfig.name}:`, error);
          // Continue with other databases even if one fails
        }
      });

      // Wait for all databases to initialize in parallel
      await Promise.all(initPromises);

      // Create HTTP server and attach WebSocket
      console.log('Starting HTTP server...');
      this.server = http.createServer(this.app);

      this.server.listen(config.port, () => {
        console.log(`DuckDB Server running on port ${config.port}`);
        console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
        console.log('Architecture: Sequential Appender with ACID transactions');
        console.log('Features: Atomic sync, watermark-based incremental, streaming batches, WebSocket, multi-database');
        console.log(`Databases initialized: ${allDatabases.length}`);
        console.log('Ready for manual operations via UI/API');
      });

      // Initialize WebSocket service
      console.log('Initializing WebSocket service...');
      this.websocketService.initialize(this.server);

      // Initialize log buffer service
      console.log('Initializing log buffer service...');
      this.logBufferService.initialize();

      console.log('Server startup completed successfully');
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Get logs API endpoint
   */
  private async getLogs(req: express.Request, res: express.Response): Promise<void> {
    try {
      const sinceId = parseInt(req.query.since as string) || 0;
      const levels = req.query.levels ? (req.query.levels as string).split(',') : undefined;

      const logs = this.logBufferService.getLogs(sinceId, levels);

      res.json({
        success: true,
        logs,
        count: logs.length,
        stats: this.logBufferService.getStats()
      });
    } catch (error) {
      logger.error('Failed to get logs:', error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get sync logs from database
   */
  private async getSyncLogs(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { duckdb } = req as RequestWithDatabase;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string; // 'success', 'error', or undefined for all
      const tableName = req.query.table as string; // Filter by specific table

      let whereClause = '';
      const conditions: string[] = [];
      const params: any[] = [];

      if (status) {
        conditions.push(`status = ?`);
        params.push(status);
      }
      if (tableName) {
        conditions.push(`table_name = ?`);
        params.push(tableName);
      }

      if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
      }

      params.push(limit, offset);

      const query = `
        SELECT
          id,
          table_name,
          sync_type,
          records_processed,
          duration_ms,
          status,
          error_message,
          watermark_before,
          watermark_after,
          created_at
        FROM sync_log
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
      `;

      const logs = await duckdb.query(query, params);

      // Get total count
      const countQuery = `SELECT COUNT(*) as count FROM sync_log ${whereClause}`;
      const countResult = await duckdb.query(countQuery);
      const total = countResult?.[0]?.count || 0;

      // Serialize BigInt values for JSON
      const serializedLogs = logs.map((log: any) => ({
        id: typeof log.id === 'bigint' ? log.id.toString() : log.id,
        table_name: log.table_name,
        sync_type: log.sync_type,
        records_processed: typeof log.records_processed === 'bigint' ? Number(log.records_processed) : log.records_processed,
        duration_ms: typeof log.duration_ms === 'bigint' ? Number(log.duration_ms) : log.duration_ms,
        status: log.status,
        error_message: log.error_message,
        watermark_before: log.watermark_before,
        watermark_after: log.watermark_after,
        created_at: log.created_at
      }));

      res.json({
        success: true,
        logs: serializedLogs,
        count: logs.length,
        total: Number(total),
        limit,
        offset
      });
    } catch (error) {
      logger.error('Failed to get sync logs:', error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Stop the HTTP server gracefully
   */
  async stop(): Promise<void> {
    stopRateLimitCleanup();

    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      // Stop accepting new connections and wait for existing to close
      this.server.close((err) => {
        if (err) {
          logger.error('Error closing HTTP server:', err);
          reject(err);
        } else {
          logger.info('HTTP server closed successfully');
          resolve();
        }
      });

      // Force close after 10 seconds
      setTimeout(() => {
        logger.warn('Forcing HTTP server close after timeout');
        resolve();
      }, 10000);
    });
  }

}

export default DuckDBServer;