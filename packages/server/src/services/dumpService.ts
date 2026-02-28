import MySQLConnection from '../database/mysql';
import DuckDBConnection from '../database/duckdb';
import { DatabaseConfigManager } from '../database/databaseConfig';
import config from '../config';
import logger from '../logger';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface DumpResult {
  success: boolean;
  dumpFile?: string;
  totalTables: number;
  totalRecords: number;
  duration: number;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  totalTables: number;
  totalRecords: number;
  duration: number;
  error?: string;
}

class DumpService {
  private mysql: MySQLConnection;
  private duckdb: DuckDBConnection;
  private static instance: DumpService;

  /** Double-quote a DuckDB identifier, escaping embedded double-quotes. */
  private q(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  private constructor() {
    // Legacy service - uses first database in config
    const dbManager = DatabaseConfigManager.getInstance();
    const databases = dbManager.getAllDatabases();

    if (databases.length === 0) {
      throw new Error('No databases configured');
    }

    const firstDb = databases[0];
    let resolvedDuckdbPath = firstDb.duckdbPath;
    if (resolvedDuckdbPath.startsWith('data/')) {
      resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
    }

    this.mysql = MySQLConnection.getInstance(firstDb.id, firstDb.mysqlConnectionString);
    this.duckdb = DuckDBConnection.getInstance(firstDb.id, resolvedDuckdbPath);
  }

  static getInstance(): DumpService {
    if (!DumpService.instance) {
      DumpService.instance = new DumpService();
    }
    return DumpService.instance;
  }

  async createFullDump(): Promise<DumpResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFile = path.join(__dirname, '..', '..', 'dumps', `mysql_dump_${timestamp}.sql`);
    
    logger.info('Starting streaming full database dump...');

    try {
      // Ensure dumps directory exists
      const dumpsDir = path.dirname(dumpFile);
      if (!fs.existsSync(dumpsDir)) {
        fs.mkdirSync(dumpsDir, { recursive: true });
      }

      const tables = await this.mysql.getTables();
      let totalRecords = 0;

      // Log table filtering
      logger.info('Table filtering applied:', {
        excludedTables: config.sync.excludedTables,
        includedTables: tables.length,
        tables: tables
      });

      // Create write stream for memory efficiency
      const writeStream = fs.createWriteStream(dumpFile, { encoding: 'utf8' });

      // Add dump header
      writeStream.write('-- Full MySQL Database Dump\n');
      writeStream.write(`-- Generated on: ${new Date().toISOString()}\n`);
      writeStream.write('-- DuckDB Server MySQL to DuckDB Replication\n');
      writeStream.write('-- Clean SQL dump for DuckDB compatibility\n');
      writeStream.write(`-- Excluded tables: ${config.sync.excludedTables.join(', ')}\n`);
      writeStream.write(`-- Included tables: ${tables.length}\n`);
      writeStream.write('\n');
      
      // Dump each table with streaming
      for (const tableName of tables) {
        logger.info(`Streaming dump of table: ${tableName}`);
        
        const tableRecordCount = await this.streamDumpTable(tableName, writeStream);
        totalRecords += tableRecordCount;
        
        logger.info(`Streamed ${tableRecordCount} records from ${tableName}`);
        
        // Force garbage collection between tables if available
        if (global.gc) {
          global.gc();
        }
      }

      // Close the write stream
      await new Promise<void>((resolve, reject) => {
        writeStream.end((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      const duration = Date.now() - startTime;
      
      logger.info('Streaming dump completed', {
        dumpFile,
        totalTables: tables.length,
        totalRecords,
        duration
      });

      return {
        success: true,
        dumpFile,
        totalTables: tables.length,
        totalRecords,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      logger.error('Streaming dump failed:', error);
      
      return {
        success: false,
        totalTables: 0,
        totalRecords: 0,
        duration,
        error: errorMessage
      };
    }
  }

  private async streamDumpTable(tableName: string, writeStream: fs.WriteStream): Promise<number> {
    try {
      // Get table schema
      const schema = await this.mysql.getTableSchema(tableName);
      
      // Create table definition
      const columns = schema.map(col => {
        let type = this.mapMySQLTypeToDuckDB(col.Type);
        let nullable = col.Null === 'YES' ? '' : ' NOT NULL';
        // Skip MySQL-specific extras like auto_increment, DEFAULT_GENERATED, etc.
        return `  ${this.q(col.Field)} ${type}${nullable}`;
      });

      const createTable = `CREATE TABLE IF NOT EXISTS ${this.q(tableName)} (\n${columns.join(',\n')}\n);\n\n`;
      writeStream.write(`-- Table: ${tableName}\n`);
      writeStream.write(createTable);
      writeStream.write(`-- Data for table: ${tableName}\n`);
      
      // Get table data in batches and stream to file
      let offset = 0;
      let recordCount = 0;
      const DUMP_BATCH_SIZE = Math.min(config.sync.batchSize, 500); // Smaller batches for dumps
      
      let batch: any[];
      do {
        batch = await this.mysql.getTableData(tableName, DUMP_BATCH_SIZE, offset);
        
        if (batch.length > 0) {
          const columnNames = Object.keys(batch[0]);
          
          for (const row of batch) {
            const values = columnNames.map(col => {
              const value = row[col];
              if (value === null) return 'NULL';
              if (typeof value === 'string') {
                // Comprehensive escaping for DuckDB compatibility
                const escaped = value
                  .replace(/\\/g, '\\\\')  // Escape backslashes first
                  .replace(/'/g, "''")     // Escape single quotes
                  .replace(/"/g, '\\"')    // Escape double quotes
                  .replace(/\n/g, '\\n')   // Escape newlines
                  .replace(/\r/g, '\\r')   // Escape carriage returns
                  .replace(/\t/g, '\\t');  // Escape tabs
                return `'${escaped}'`;
              }
              if (typeof value === 'object' && value !== null) {
                // For JSON objects, use simple JSON.stringify without manual escaping
                // DuckDB will handle the JSON type conversion properly
                const jsonString = JSON.stringify(value);
                return `'${jsonString.replace(/'/g, "''")}'`; // Only escape single quotes
              }
              if (typeof value === 'boolean') return value ? '1' : '0';
              if (value instanceof Date) return `'${value.toISOString()}'`;
              return String(value);
            });
            
            const insertStatement = `INSERT INTO ${this.q(tableName)} (${columnNames.map(c => this.q(c)).join(', ')}) VALUES (${values.join(', ')});\n`;
            writeStream.write(insertStatement);
          }
          
          recordCount += batch.length;
          offset += DUMP_BATCH_SIZE;
          
          // Log progress for large tables
          if (recordCount % 10000 === 0) {
            logger.info(`Processed ${recordCount} records for ${tableName}`);
          }
        }
      } while (batch.length === DUMP_BATCH_SIZE);

      writeStream.write('\n');
      return recordCount;

    } catch (error) {
      logger.error(`Failed to stream dump table ${tableName}:`, error);
      throw error;
    }
  }

  private async dumpTable(tableName: string): Promise<{ sql: string; recordCount: number }> {
    try {
      // Get table schema
      const schema = await this.mysql.getTableSchema(tableName);
      
      // Create table definition
      const columns = schema.map(col => {
        let type = this.mapMySQLTypeToDuckDB(col.Type);
        let nullable = col.Null === 'YES' ? '' : ' NOT NULL';
        // Skip MySQL-specific extras like auto_increment, DEFAULT_GENERATED, etc.
        return `  ${this.q(col.Field)} ${type}${nullable}`;
      });

      const createTable = `CREATE TABLE IF NOT EXISTS ${this.q(tableName)} (\n${columns.join(',\n')}\n);`;
      
      // Get all table data
      let offset = 0;
      let recordCount = 0;
      const insertStatements: string[] = [];
      
      let batch: any[];
      do {
        batch = await this.mysql.getTableData(tableName, config.sync.batchSize, offset);
        
        if (batch.length > 0) {
          const columnNames = Object.keys(batch[0]);
          
          for (const row of batch) {
            const values = columnNames.map(col => {
              const value = row[col];
              if (value === null) return 'NULL';
              if (typeof value === 'string') {
                // Comprehensive escaping for DuckDB compatibility
                const escaped = value
                  .replace(/\\/g, '\\\\')  // Escape backslashes first
                  .replace(/'/g, "''")     // Escape single quotes
                  .replace(/"/g, '\\"')    // Escape double quotes
                  .replace(/\n/g, '\\n')   // Escape newlines
                  .replace(/\r/g, '\\r')   // Escape carriage returns
                  .replace(/\t/g, '\\t');  // Escape tabs
                return `'${escaped}'`;
              }
              if (typeof value === 'object' && value !== null) {
                // For JSON objects, use simple JSON.stringify without manual escaping
                // DuckDB will handle the JSON type conversion properly
                const jsonString = JSON.stringify(value);
                return `'${jsonString.replace(/'/g, "''")}'`; // Only escape single quotes
              }
              if (typeof value === 'boolean') return value ? '1' : '0';
              if (value instanceof Date) return `'${value.toISOString()}'`;
              return String(value);
            });
            
            insertStatements.push(`INSERT INTO ${this.q(tableName)} (${columnNames.map(c => this.q(c)).join(', ')}) VALUES (${values.join(', ')});`);
          }
          
          recordCount += batch.length;
          offset += config.sync.batchSize;
        }
      } while (batch.length === config.sync.batchSize);

      const sql = [
        `-- Table: ${tableName}`,
        createTable,
        '',
        `-- Data for table: ${tableName}`,
        ...insertStatements,
        ''
      ].join('\n');

      return { sql, recordCount };

    } catch (error) {
      logger.error(`Failed to dump table ${tableName}:`, error);
      throw error;
    }
  }

  async restoreFromDump(dumpFile: string): Promise<RestoreResult> {
    const startTime = Date.now();
    
    logger.info(`Starting streaming restore from dump: ${dumpFile}`);

    try {
      if (!fs.existsSync(dumpFile)) {
        throw new Error(`Dump file not found: ${dumpFile}`);
      }

      // Initialize DuckDB if not already done
      await this.duckdb.initializeDatabase();

      // Use streaming file processing
      const result = await this.streamingRestoreFromDump(dumpFile);

      const duration = Date.now() - startTime;
      
      logger.info('Streaming restore completed successfully', {
        dumpFile,
        totalTables: result.totalTables,
        totalRecords: result.totalRecords,
        duration
      });

      return {
        success: true,
        totalTables: result.totalTables,
        totalRecords: result.totalRecords,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      logger.error('Restore failed:', error);
      
      return {
        success: false,
        totalTables: 0,
        totalRecords: 0,
        duration,
        error: errorMessage
      };
    }
  }

  private async streamingRestoreFromDump(dumpFile: string): Promise<{totalTables: number, totalRecords: number}> {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createReadStream(dumpFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let totalTables = 0;
      let totalRecords = 0;
      let currentStatement = '';
      let statementCount = 0;
      let processedLines = 0;

      const processStatement = async (statement: string): Promise<void> => {
        if (!this.isValidStatement(statement)) {
          return;
        }

        try {
          await this.duckdb.run(statement);
          
          if (statement.toUpperCase().includes('CREATE TABLE')) {
            totalTables++;
          } else if (statement.toUpperCase().includes('INSERT INTO')) {
            totalRecords++;
          }
        } catch (error) {
          logger.warn(`Failed to execute statement ${statementCount + 1}:`, {
            statement: statement.substring(0, 100) + '...',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          // Continue with next statement
        }
      };

      const processQueue: Promise<void>[] = [];
      const BATCH_SIZE = 100;

      rl.on('line', (line: string) => {
        processedLines++;
        
        // Log progress every 10000 lines
        if (processedLines % 10000 === 0) {
          logger.info(`Processed ${processedLines} lines, ${totalTables} tables, ${totalRecords} records`);
          
          // Force garbage collection if available
          if (global.gc) {
            global.gc();
          }
        }

        const trimmed = line.trim();
        
        // Skip problematic lines early
        if (this.shouldSkipLine(trimmed)) {
          return;
        }

        currentStatement += (currentStatement ? ' ' : '') + trimmed;

        // Check if statement is complete (ends with semicolon)
        if (trimmed.endsWith(';')) {
          const statement = currentStatement.trim();
          if (statement) {
            statementCount++;
            
            // Add to processing queue
            processQueue.push(processStatement(statement));
            
            // Process statements in batches to avoid memory buildup
            if (processQueue.length >= BATCH_SIZE) {
              Promise.all(processQueue.splice(0, BATCH_SIZE)).catch(reject);
            }
          }
          currentStatement = '';
        }
      });

      rl.on('error', (error) => {
        reject(error);
      });

      rl.on('close', async () => {
        try {
          // Process remaining statements
          if (processQueue.length > 0) {
            await Promise.all(processQueue);
          }
          
          // Process any remaining partial statement
          if (currentStatement.trim()) {
            await processStatement(currentStatement.trim());
          }

          logger.info(`Streaming restore completed: ${processedLines} lines processed, ${statementCount} statements executed`);
          resolve({ totalTables, totalRecords });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private shouldSkipLine(line: string): boolean {
    if (!line) return true;
    
    // Skip comment lines
    if (line.startsWith('--') || line.startsWith('#')) return true;
    
    // Skip MySQL-specific directives
    if (line.startsWith('/*!') || line.startsWith('SET ')) return true;
    
    // Skip LOCK/UNLOCK statements
    const upperLine = line.toUpperCase();
    if (upperLine.includes('LOCK TABLES') || upperLine.includes('UNLOCK TABLES')) return true;
    
    // Skip MySQL-specific commands
    if (upperLine.startsWith('USE ') || upperLine.startsWith('SHOW ') || upperLine.startsWith('SOURCE ')) return true;
    
    return false;
  }

  private isValidStatement(statement: string): boolean {
    if (!statement) return false;
    
    const upperStmt = statement.toUpperCase();
    
    // Skip problematic patterns
    if (upperStmt.includes('WIN64') || 
        upperStmt.includes('MYSQL') ||
        upperStmt.includes('MARIADB') ||
        upperStmt.startsWith('SET ') ||
        upperStmt.startsWith('/*')) {
      return false;
    }
    
    // Only allow CREATE TABLE and INSERT statements
    return upperStmt.startsWith('CREATE TABLE') || upperStmt.startsWith('INSERT INTO');
  }

  private parseDumpFile(content: string): string[] {
    // Clean the content first
    const lines = content.split('\n');
    const cleanedLines: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines
      if (!trimmed) continue;
      
      // Skip comment lines (starting with -- or #)
      if (trimmed.startsWith('--') || trimmed.startsWith('#')) continue;
      
      // Skip MySQL-specific directives and system info
      if (trimmed.startsWith('/*!') || trimmed.startsWith('SET ')) continue;
      
      // Skip LOCK/UNLOCK TABLES statements
      if (trimmed.toUpperCase().includes('LOCK TABLES') || 
          trimmed.toUpperCase().includes('UNLOCK TABLES')) continue;
      
      // Skip other MySQL-specific statements
      if (trimmed.toUpperCase().startsWith('USE ') ||
          trimmed.toUpperCase().startsWith('SHOW ') ||
          trimmed.toUpperCase().startsWith('SOURCE ')) continue;
          
      cleanedLines.push(trimmed);
    }
    
    // Join lines and split by semicolon
    const cleanedContent = cleanedLines.join(' ');
    
    return cleanedContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => {
        // Additional filtering
        if (!stmt) return false;
        
        // Skip statements that contain problematic patterns
        const upperStmt = stmt.toUpperCase();
        if (upperStmt.includes('WIN64') || 
            upperStmt.includes('MYSQL') ||
            upperStmt.includes('MARIADB') ||
            upperStmt.startsWith('SET ') ||
            upperStmt.startsWith('/*')) return false;
        
        // Only allow CREATE TABLE and INSERT statements
        return upperStmt.startsWith('CREATE TABLE') || upperStmt.startsWith('INSERT INTO');
      })
      .map(stmt => stmt.endsWith(';') ? stmt : stmt + ';');
  }

  private mapMySQLTypeToDuckDB(mysqlType: string): string {
    return mapMySQLTypeToDuckDB(mysqlType);
  }

  async listDumps(): Promise<string[]> {
    const dumpsDir = path.join(__dirname, '..', '..', 'dumps');
    
    if (!fs.existsSync(dumpsDir)) {
      return [];
    }

    return fs.readdirSync(dumpsDir)
      .filter(file => file.endsWith('.sql'))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(dumpsDir, a));
        const statB = fs.statSync(path.join(dumpsDir, b));
        return statB.mtime.getTime() - statA.mtime.getTime(); // Newest first
      });
  }

  async getDumpInfo(dumpFileName: string): Promise<any> {
    const dumpFile = path.join(__dirname, '..', '..', 'dumps', dumpFileName);
    
    if (!fs.existsSync(dumpFile)) {
      throw new Error(`Dump file not found: ${dumpFileName}`);
    }

    const stats = fs.statSync(dumpFile);
    const content = fs.readFileSync(dumpFile, 'utf8');
    
    // Parse basic info from dump
    const lines = content.split('\n');
    const createTableCount = lines.filter(line => 
      line.toUpperCase().includes('CREATE TABLE')
    ).length;
    
    const insertCount = lines.filter(line => 
      line.toUpperCase().includes('INSERT INTO')
    ).length;

    return {
      fileName: dumpFileName,
      filePath: dumpFile,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      estimatedTables: createTableCount,
      estimatedRecords: insertCount
    };
  }

  async cleanupOldDumps(keepDays: number = 7): Promise<number> {
    const dumpsDir = path.join(__dirname, '..', '..', 'dumps');
    
    if (!fs.existsSync(dumpsDir)) {
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - keepDays);

    const files = fs.readdirSync(dumpsDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.sql')) {
        const filePath = path.join(dumpsDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          deletedCount++;
          logger.info(`Deleted old dump file: ${file}`);
        }
      }
    }

    logger.info(`Cleanup completed: deleted ${deletedCount} old dump files`);
    return deletedCount;
  }
}

export default DumpService;

/**
 * Map a MySQL column type string to the corresponding DuckDB type.
 * Exported for unit testing. The DumpService class delegates to this.
 */
export function mapMySQLTypeToDuckDB(mysqlType: string): string {
  const type = mysqlType.toLowerCase();

  // Check string/text types FIRST (before numeric checks) to avoid false matches
  // e.g., enum('Internship') contains 'int' but should map to VARCHAR
  if (type.includes('enum')) return 'VARCHAR';
  if (type.includes('set')) return 'VARCHAR';
  if (type.includes('json')) return 'JSON';
  if (type.includes('text')) return 'TEXT';
  if (type.includes('varchar') || type.includes('char')) return 'VARCHAR';
  if (type.includes('blob') || type.includes('binary')) return 'BLOB';

  // Timestamp and date types
  if (type.includes('timestamp')) return 'TIMESTAMP';
  if (type.includes('datetime')) return 'TIMESTAMP';
  if (type.includes('date')) return 'DATE';
  if (type.includes('time')) return 'TIME';

  // Numeric types (check these AFTER string types)
  // Use BIGINT for all integer types to prevent overflow errors
  // MySQL often has values that exceed INT32 range even in INT columns
  if (type.includes('bigint')) return 'BIGINT';
  if (type.includes('tinyint')) return 'TINYINT';
  if (type.includes('smallint')) return 'SMALLINT';
  if (type.includes('mediumint')) return 'BIGINT';
  if (type.includes('int')) return 'BIGINT';
  if (type.includes('decimal') || type.includes('numeric')) return 'DECIMAL';
  if (type.includes('float')) return 'FLOAT';
  if (type.includes('double')) return 'DOUBLE';
  if (type.includes('boolean') || type.includes('bool')) return 'BOOLEAN';
  if (type.includes('bit')) return 'VARCHAR';

  return 'VARCHAR';
}