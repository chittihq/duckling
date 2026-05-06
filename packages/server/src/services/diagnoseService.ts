import MySQLConnection from '../database/mysql';
import logger from '../logger';

// --- Types ---

interface DiagnoseCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

interface TableDiagnosis {
  table: string;
  estimatedRows: number;
  primaryKey: string | null;
  timestampColumn: string | null;
  timestampQuality: 'best' | 'append-only' | 'none';
  unsupportedColumns: Array<{ column: string; type: string; mapping: string }>;
  charset: string;
}

export interface DiagnoseResult {
  server: DiagnoseCheck[];
  tables: TableDiagnosis[];
  summary: {
    totalTables: number;
    tablesWithPrimaryKey: number;
    tablesWithTimestamp: number;
    totalColumns: number;
    unsupportedColumns: number;
  };
}

export interface DiagnoseProgressEvent {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

// --- Type mapping for sync compatibility ---

function mapMySQLTypeToClickHouse(mysqlType: string): { clickhouseType: string; isDefault: boolean } {
  const type = mysqlType.toLowerCase();

  // String/text types first to avoid false matches (e.g. enum('Internship') contains 'int')
  if (type.includes('enum')) return { clickhouseType: 'String', isDefault: false };
  if (type.includes('set')) return { clickhouseType: 'String', isDefault: false };
  if (type.includes('json')) return { clickhouseType: 'String', isDefault: false };
  if (type.includes('text')) return { clickhouseType: 'String', isDefault: false };
  if (type.includes('varchar') || type.includes('char')) return { clickhouseType: 'String', isDefault: false };
  if (type.includes('blob') || type.includes('binary')) return { clickhouseType: 'String', isDefault: false };

  // Timestamp and date types
  if (type.includes('timestamp')) return { clickhouseType: 'DateTime64(3)', isDefault: false };
  if (type.includes('datetime')) return { clickhouseType: 'DateTime64(3)', isDefault: false };
  if (type.includes('date')) return { clickhouseType: 'DateTime64(3)', isDefault: false };
  if (type.includes('time')) return { clickhouseType: 'DateTime64(3)', isDefault: false };

  // Numeric types
  if (type.includes('bigint')) return { clickhouseType: 'Int64', isDefault: false };
  if (type.includes('tinyint')) return { clickhouseType: 'Int8', isDefault: false };
  if (type.includes('smallint')) return { clickhouseType: 'Int16', isDefault: false };
  if (type.includes('mediumint')) return { clickhouseType: 'Int32', isDefault: false };
  if (type.includes('int')) return { clickhouseType: 'Int32', isDefault: false };
  if (type.includes('decimal') || type.includes('numeric')) return { clickhouseType: 'Decimal', isDefault: false };
  if (type.includes('float')) return { clickhouseType: 'Float32', isDefault: false };
  if (type.includes('double')) return { clickhouseType: 'Float64', isDefault: false };
  if (type.includes('boolean') || type.includes('bool')) return { clickhouseType: 'UInt8', isDefault: false };
  if (type.includes('bit')) return { clickhouseType: 'String', isDefault: false };

  // Fallback — truly unsupported type
  return { clickhouseType: 'String', isDefault: true };
}

// --- Timestamp detection (same priority as sequentialAppenderService) ---

const BEST_TIMESTAMP_PATTERNS = ['updated_at', 'modified_at', 'updatedat', 'modifiedat'];
const OK_TIMESTAMP_PATTERNS = ['timestamp'];
const APPEND_ONLY_PATTERNS = ['created_at', 'createdat'];

function detectTimestampColumn(schema: any[]): { column: string | null; quality: 'best' | 'append-only' | 'none' } {
  for (const pattern of BEST_TIMESTAMP_PATTERNS) {
    const col = schema.find(c => c.Field.toLowerCase() === pattern);
    if (col) return { column: col.Field, quality: 'best' };
  }
  for (const pattern of OK_TIMESTAMP_PATTERNS) {
    const col = schema.find(c => c.Field.toLowerCase() === pattern);
    if (col) return { column: col.Field, quality: 'best' };
  }
  for (const pattern of APPEND_ONLY_PATTERNS) {
    const col = schema.find(c => c.Field.toLowerCase() === pattern);
    if (col) return { column: col.Field, quality: 'append-only' };
  }
  return { column: null, quality: 'none' };
}

// --- Helper to run a SHOW VARIABLES query safely ---

async function getVariable(mysql: MySQLConnection, varName: string): Promise<string | null> {
  try {
    const rows = await mysql.execute(`SHOW VARIABLES LIKE ?`, [varName]);
    return rows.length > 0 ? rows[0].Value : null;
  } catch {
    return null;
  }
}

// --- Main diagnose function ---

export async function diagnoseDatabase(
  mysql: MySQLConnection,
  onProgress?: (event: DiagnoseProgressEvent) => void
): Promise<DiagnoseResult> {
  const serverChecks: DiagnoseCheck[] = [];
  const reportProgress = (event: DiagnoseProgressEvent): void => {
    if (onProgress) onProgress(event);
  };

  // 1. Connection test
  try {
    await mysql.execute('SELECT 1');
    const check = { name: 'Connection', status: 'pass' as const, detail: 'OK' };
    serverChecks.push(check);
    reportProgress(check);
  } catch (err: any) {
    const check = { name: 'Connection', status: 'fail' as const, detail: err.message || 'Connection failed' };
    serverChecks.push(check);
    reportProgress(check);
    // Can't continue if connection fails
    return {
      server: serverChecks,
      tables: [],
      summary: { totalTables: 0, tablesWithPrimaryKey: 0, tablesWithTimestamp: 0, totalColumns: 0, unsupportedColumns: 0 },
    };
  }

  // 2. Server charset
  const charset = await getVariable(mysql, 'character_set_server');
  if (charset) {
    const check: DiagnoseProgressEvent = {
      name: 'Server charset',
      status: charset === 'utf8mb4' ? 'pass' : 'warn',
      detail: charset === 'utf8mb4' ? charset : `${charset} — 4-byte emoji will be lost`,
    };
    serverChecks.push(check);
    reportProgress(check);
  }

  // 3. Server collation
  const collation = await getVariable(mysql, 'collation_server');
  if (collation) {
    const check: DiagnoseProgressEvent = {
      name: 'Server collation',
      status: collation.startsWith('utf8mb4') ? 'pass' : 'warn',
      detail: collation,
    };
    serverChecks.push(check);
    reportProgress(check);
  }

  // 4. Binlog enabled
  const logBin = await getVariable(mysql, 'log_bin');
  {
    const check: DiagnoseProgressEvent = logBin !== null
      ? { name: 'Binlog enabled', status: logBin === 'ON' ? 'pass' : 'warn', detail: logBin === 'ON' ? 'ON' : 'OFF — CDC will not work' }
      : { name: 'Binlog enabled', status: 'warn', detail: 'Not available — insufficient privileges' };
    serverChecks.push(check);
    reportProgress(check);
  }

  // 5. Binlog format
  const binlogFormat = await getVariable(mysql, 'binlog_format');
  {
    const check: DiagnoseProgressEvent = binlogFormat !== null
      ? { name: 'Binlog format', status: binlogFormat === 'ROW' ? 'pass' : 'warn', detail: binlogFormat === 'ROW' ? 'ROW' : `${binlogFormat} — CDC needs ROW format` }
      : { name: 'Binlog format', status: 'warn', detail: 'Not available — insufficient privileges' };
    serverChecks.push(check);
    reportProgress(check);
  }

  // 6. Binlog row image
  const binlogRowImage = await getVariable(mysql, 'binlog_row_image');
  {
    const check: DiagnoseProgressEvent = binlogRowImage !== null
      ? { name: 'Binlog row image', status: binlogRowImage === 'FULL' ? 'pass' : 'warn', detail: binlogRowImage === 'FULL' ? 'FULL' : `${binlogRowImage} — CDC may miss columns` }
      : { name: 'Binlog row image', status: 'warn', detail: 'Not available — insufficient privileges' };
    serverChecks.push(check);
    reportProgress(check);
  }

  // 7. sql_mode zero dates
  try {
    const rows = await mysql.execute('SELECT @@sql_mode as mode');
    const sqlMode = rows[0]?.mode || '';
    const hasNoZeroDate = sqlMode.includes('NO_ZERO_DATE');
    const check: DiagnoseProgressEvent = {
      name: 'Zero-date handling',
      status: hasNoZeroDate ? 'pass' : 'warn',
      detail: hasNoZeroDate ? 'NO_ZERO_DATE enabled' : 'NO_ZERO_DATE not set — zero dates may appear',
    };
    serverChecks.push(check);
    reportProgress(check);
  } catch {
    // skip
  }

  // --- Per-table analysis ---
  const tables = await mysql.getTables();
  const rowCounts = await mysql.getAllTableRowCountsFast();

  // Get table statuses in one query for charset info
  let tableStatuses: Map<string, string> = new Map();
  try {
    const statusRows = await mysql.execute(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
    );
    for (const row of statusRows) {
      tableStatuses.set(row.TABLE_NAME, row.TABLE_COLLATION || 'unknown');
    }
  } catch (err) {
    logger.warn('Failed to get table statuses for diagnose:', err);
  }

  const tableDiagnoses: TableDiagnosis[] = [];
  let totalColumns = 0;
  let totalUnsupported = 0;

  for (const table of tables) {
    try {
      const schema = await mysql.getTableSchema(table);

      // Primary key
      const pkCol = schema.find((c: any) => c.Key === 'PRI');
      const primaryKey = pkCol ? pkCol.Field : null;

      // Timestamp
      const ts = detectTimestampColumn(schema);

      // Column type mapping
      const unsupported: Array<{ column: string; type: string; mapping: string }> = [];
      for (const col of schema) {
        const { clickhouseType, isDefault } = mapMySQLTypeToClickHouse(col.Type);
        if (isDefault) {
          unsupported.push({ column: col.Field, type: col.Type, mapping: clickhouseType });
        }
      }

      totalColumns += schema.length;
      totalUnsupported += unsupported.length;

      tableDiagnoses.push({
        table,
        estimatedRows: rowCounts.get(table) || 0,
        primaryKey,
        timestampColumn: ts.column,
        timestampQuality: ts.quality,
        unsupportedColumns: unsupported,
        charset: tableStatuses.get(table) || 'unknown',
      });
    } catch (err) {
      logger.warn(`Diagnose failed for table ${table}:`, err);
      tableDiagnoses.push({
        table,
        estimatedRows: 0,
        primaryKey: null,
        timestampColumn: null,
        timestampQuality: 'none',
        unsupportedColumns: [],
        charset: 'error',
      });
    }
  }

  const tablesWithPK = tableDiagnoses.filter(t => t.primaryKey !== null).length;
  const tablesWithTS = tableDiagnoses.filter(t => t.timestampColumn !== null).length;

  return {
    server: serverChecks,
    tables: tableDiagnoses,
    summary: {
      totalTables: tableDiagnoses.length,
      tablesWithPrimaryKey: tablesWithPK,
      tablesWithTimestamp: tablesWithTS,
      totalColumns,
      unsupportedColumns: totalUnsupported,
    },
  };
}
