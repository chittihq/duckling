import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as http from 'http';
import DuckDBConnection from './database/duckdb';
import MySQLConnection from './database/mysql';
import SequentialAppenderService from './services/sequentialAppenderService';
import AutomationService from './services/automationService';
import WebSocketService from './services/websocketService';
import LogBufferService from './services/logBufferService';
import { DatabaseConfigManager } from './database/databaseConfig';
import { attachDatabaseContext, RequestWithDatabase } from './middleware/database';
import { generateToken, verifyToken, extractTokenFromHeader } from './utils/jwtUtils';
import config from './config';
import logger from './logger';

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
  private duckdb: DuckDBConnection;
  private mysql: MySQLConnection;
  private syncService: SequentialAppenderService;
  private automationService: AutomationService;
  private websocketService: WebSocketService;
  private logBufferService: LogBufferService;

  constructor() {
    this.app = express();
    this.duckdb = DuckDBConnection.getInstance();
    this.mysql = MySQLConnection.getInstance();
    this.syncService = SequentialAppenderService.getInstance();
    this.automationService = AutomationService.getInstance();
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

    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
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

    // Global authentication middleware - protects API routes only
    this.app.use((req, res, next) => {
      // Public API routes (no auth required)
      const publicApiPaths = ['/api/login', '/api/check-auth', '/openapi.json'];

      // Only protect API routes (except public ones)
      // All frontend SPA routes are public and served by index.html
      if (req.path.startsWith('/api/') && !publicApiPaths.includes(req.path)) {
        // API routes (except public ones) require authentication
        return this.checkApiKeyOrSession(req, res, next);
      }

      // Allow all non-API routes (frontend SPA, static assets, etc.)
      next();
    });

    // Protected API endpoints (require authentication via JWT, API key, or session)

    // Logs API endpoints
    this.app.get('/api/logs', this.getLogs.bind(this));
    this.app.get('/api/sync-logs', this.getSyncLogs.bind(this));

    // Database management endpoints
    this.app.get('/api/databases', this.getDatabases.bind(this));
    this.app.post('/api/databases', this.addDatabase.bind(this));
    this.app.put('/api/databases/:id', this.updateDatabase.bind(this));
    this.app.delete('/api/databases/:id', this.deleteDatabase.bind(this));
    this.app.post('/api/databases/:id/test', this.testDatabaseConnection.bind(this));

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

    // Data access endpoints (with database context)
    this.app.post('/query', attachDatabaseContext, this.executeQuery.bind(this));
    this.app.get('/tables', attachDatabaseContext, this.getTables.bind(this));
    this.app.get('/tables/counts/all', attachDatabaseContext, this.getAllTableCounts.bind(this));
    this.app.get('/tables/:name/schema', attachDatabaseContext, this.getTableSchema.bind(this));
    this.app.get('/tables/:name/data', attachDatabaseContext, this.getTableData.bind(this));
    this.app.get('/tables/:name/count', attachDatabaseContext, this.getTableRowCount.bind(this));

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
        if (require('fs').existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          // In development, Nuxt runs separately, so just return 404
          res.status(404).json({ error: 'Not found' });
        }
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });

    this.app.use(this.errorHandler.bind(this));
  }

  private async healthCheck(req: express.Request, res: express.Response): Promise<void> {
    try {
      const mysqlHealthy = await this.mysql.testConnection();
      const duckdbHealthy = await this.duckdb.testConnection();
      
      const health = {
        status: mysqlHealthy && duckdbHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          mysql: mysqlHealthy ? 'healthy' : 'unhealthy',
          duckdb: duckdbHealthy ? 'healthy' : 'unhealthy'
        },
        architecture: 'sequential-appender',
        features: ['atomic-transactions', 'watermark-sync', 'streaming-batches', 'acid-compliance']
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
      const mysqlTables = await this.mysql.getTables();
      const duckdbTables = await this.duckdb.getTables();

      const status = {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        architecture: 'sequential-appender',
        config: {
          syncInterval: config.sync.intervalMinutes,
          batchSize: config.sync.batchSize,
          incrementalSync: config.sync.enableIncremental
        },
        tables: {
          mysql: mysqlTables.length,
          duckdb: duckdbTables.length
        }
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
      const { databaseId, mysql, duckdb } = req as RequestWithDatabase;
      const syncService = SequentialAppenderService.getInstance(databaseId, mysql, duckdb);
      const result = await syncService.syncSingleTable(tableName);
      res.json(result);
    } catch (error) {
      logger.error(`Single table sync failed for ${req.params.tableName}:`, error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
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
      logger.info('Starting clear all data operation');

      // Get tables to drop
      const tables = await this.duckdb.getTables();

      // Drop all tables
      for (const table of tables) {
        try {
          await this.duckdb.run(`DROP TABLE IF EXISTS ${table}`);
        } catch (error) {
          logger.warn(`Failed to drop table ${table}:`, error);
        }
      }

      // Reinitialize database (watermark table, etc.)
      logger.info('Reinitializing database after clear');
      try {
        await this.duckdb.initializeDatabase();
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
      if (database === 'mysql') {
        result = await mysql.execute(sql, params);
      } else {
        result = await duckdb.query(sql, params);
      }

      // Convert BigInt values to strings for JSON serialization
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
      const result = await this.duckdb.execute(`DESCRIBE ${name}`);
      res.json({ columns: result });
    } catch (error) {
      logger.error('Get table schema failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getTableData(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { name } = req.params;

      const data = await this.duckdb.execute(
        `SELECT * FROM ${name}`
      );
      
      // Convert BigInt values to strings for JSON serialization
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
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async getAllTableCounts(req: express.Request, res: express.Response): Promise<void> {
    try {
      const tables = await this.duckdb.getTables();
      const counts: Record<string, number> = {};

      // Get all counts in parallel
      await Promise.all(
        tables.map(async (tableName) => {
          try {
            const count = await this.duckdb.getTableRowCount(tableName);
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
      const { duckdb } = req as RequestWithDatabase;
      const count = await duckdb.getTableRowCount(name);
      // Convert BigInt to number for JSON serialization
      const serializedCount = typeof count === 'bigint' ? Number(count) : count;
      res.json({ count: serializedCount });
    } catch (error) {
      logger.error('Get table row count failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Enhanced metrics
  private async getMetrics(req: express.Request, res: express.Response): Promise<void> {
    try {
      const status = await this.syncService.getSyncStatus();
      res.json(this.serializeBigInt({
        ...status,
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
      await automationService['performBackup']();
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
      await automationService['performCleanup']();
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
  private sanitizeDatabaseConfig(config: any): any {
    const { mysqlConnectionString, ...sanitized } = config;
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
      const { tableName } = req.body;

      if (!tableName) {
        res.status(400).json({ error: 'Table name is required' });
        return;
      }

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
          const schema = await duckdb.execute(`DESCRIBE ${tableName}`);
          duckdbColumnCount = schema.length;
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
      let mysqlRecordCount = 0;
      let mysqlColumns: string[] = [];

      try {
        const mysqlTables = await mysql.getAllTables();
        mysqlExists = mysqlTables.includes(tableName);

        if (mysqlExists) {
          // Get column count and names
          const schema = await mysql.getTableSchema(tableName);
          mysqlColumnCount = schema.length;
          mysqlColumns = schema.map((col: any) => col.Field);

          // Get record count
          const countResult = await mysql.getTableRowCount(tableName);
          mysqlRecordCount = typeof countResult === 'bigint' ? Number(countResult) : countResult;
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

      // Determine error type
      let errorType = null;
      let errorMessage = null;

      if (duckdbExists && mysqlExists) {
        if (missingColumns.length > 0) {
          errorType = 'schema_mismatch';
          errorMessage = `Missing columns in DuckDB: ${missingColumns.join(', ')}`;
        } else if (extraColumns.length > 0) {
          errorType = 'schema_mismatch';
          errorMessage = `Extra columns in DuckDB: ${extraColumns.join(', ')}`;
        } else if (duckdbRecordCount !== mysqlRecordCount) {
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
        duckdb: {
          exists: duckdbExists,
          columnCount: duckdbColumnCount,
          recordCount: duckdbRecordCount,
          columns: duckdbColumns
        },
        mysql: {
          exists: mysqlExists,
          columnCount: mysqlColumnCount,
          recordCount: mysqlRecordCount,
          columns: mysqlColumns
        },
        columnsMatch,
        missingColumns,
        extraColumns,
        errorType,
        errorMessage
      });
    } catch (error) {
      logger.error('Get table validation details failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
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
      await duckdb.run(`DROP TABLE IF EXISTS ${tableName}`);
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
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
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

      // Initialize DuckDB database
      console.log('Initializing DuckDB database...');
      await this.duckdb.initializeDatabase();

      // Create HTTP server and attach WebSocket
      console.log('Starting HTTP server...');
      this.server = http.createServer(this.app);

      this.server.listen(config.port, () => {
        console.log(`DuckDB Server running on port ${config.port}`);
        console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
        console.log('Architecture: Sequential Appender with ACID transactions');
        console.log('Features: Atomic sync, watermark-based incremental, streaming batches, WebSocket');
        console.log('Ready for manual operations via UI/API');
      });

      // Initialize WebSocket service
      console.log('Initializing WebSocket service...');
      this.websocketService.initialize(this.server);

      // Initialize log buffer service
      console.log('Initializing log buffer service...');
      this.logBufferService.initialize();

      // Start automation service (cleanup, backup, health monitoring)
      console.log('Starting automation service...');
      await this.automationService.start();

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
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string; // 'success', 'error', or undefined for all
      const tableName = req.query.table as string; // Filter by specific table

      let whereClause = '';
      const conditions: string[] = [];

      if (status) {
        conditions.push(`status = '${status}'`);
      }
      if (tableName) {
        conditions.push(`table_name = '${tableName}'`);
      }

      if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
      }

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
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const logs = await this.duckdb.query(query);

      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM sync_log ${whereClause}`;
      const countResult = await this.duckdb.query(countQuery);
      const total = countResult?.[0]?.total || 0;

      // Convert BigInt values to numbers for JSON serialization
      const serializedLogs = logs.map(log => ({
        ...log,
        id: Number(log.id),
        records_processed: Number(log.records_processed),
        duration_ms: Number(log.duration_ms)
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
   * Get sync service for direct access (used by auto-sync)
   */
  getSyncService(): SequentialAppenderService {
    return this.syncService;
  }
}

export default DuckDBServer;