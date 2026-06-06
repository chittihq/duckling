import { Request, Response, NextFunction } from 'express';
import { DatabaseConfigManager } from '../database/databaseConfig';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';

export interface RequestWithDatabase extends Request {
  databaseId: string;
  clickhouse: ClickHouseConnection;
  mysql: MySQLConnection;
}

/**
 * Middleware to extract database ID from query parameter and attach database connections
 */
export const attachDatabaseContext = (req: Request, res: Response, next: NextFunction): void => {
  // A per-database API key implies its own database, so a scoped caller that
  // omits ?db= operates on its key's database rather than 'default'. An
  // explicit ?db= that disagrees was already rejected by enforceDatabaseScope.
  const databaseId = (req.query.db as string) || req.user?.scopedDatabaseId || 'default';

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

  // Attach database ID and connections to request
  const reqWithDb = req as RequestWithDatabase;
  reqWithDb.databaseId = databaseId;
  reqWithDb.clickhouse = ClickHouseConnection.getInstance(databaseId, dbConfig.clickhouseDatabase || databaseId);
  reqWithDb.mysql = MySQLConnection.getInstance(databaseId, dbConfig.mysqlConnectionString);

  next();
};
