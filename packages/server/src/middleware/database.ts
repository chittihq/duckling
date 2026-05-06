import { Request, Response, NextFunction } from 'express';
import { DatabaseConfigManager } from '../database/databaseConfig';
import DuckDBConnection from '../database/duckdb';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';

export interface RequestWithDatabase extends Request {
  databaseId: string;
  duckdb: DuckDBConnection;
  clickhouse: ClickHouseConnection;
  mysql: MySQLConnection;
}

/**
 * Middleware to extract database ID from query parameter and attach database connections
 */
export const attachDatabaseContext = (req: Request, res: Response, next: NextFunction): void => {
  const databaseId = (req.query.db as string) || 'default';

  // Get database config
  const dbManager = DatabaseConfigManager.getInstance();
  const dbConfig = dbManager.getDatabase(databaseId);

  if (!dbConfig) {
    res.status(404).json({
      success: false,
      error: `Database '${databaseId}' not found`
    });
    return;
  }

  // Resolve duckdbPath to absolute path in mounted volume
  // If path starts with 'data/', convert to '/app/data/'
  let resolvedDuckdbPath = dbConfig.duckdbPath;
  if (resolvedDuckdbPath.startsWith('data/')) {
    resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
  }

  // Attach database ID and connections to request
  const reqWithDb = req as RequestWithDatabase;
  reqWithDb.databaseId = databaseId;
  reqWithDb.duckdb = DuckDBConnection.getInstance(databaseId, resolvedDuckdbPath);
  reqWithDb.clickhouse = ClickHouseConnection.getInstance(databaseId, dbConfig.clickhouseDatabase || databaseId);
  reqWithDb.mysql = MySQLConnection.getInstance(databaseId, dbConfig.mysqlConnectionString);

  next();
};
