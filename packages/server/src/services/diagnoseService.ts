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

interface DiagnoseResult {
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

// --- Type mapping (duplicated from sequentialAppenderService to avoid coupling) ---

function mapMySQLTypeToDuckDB(mysqlType: string): { duckdbType: string; isDefault: boolean } {
  const type = mysqlType.toLowerCase();

  // String/text types first to avoid false matches (e.g. enum('Internship') contains 'int')
  if (type.includes('enum')) return { duckdbType: 'VARCHAR', isDefault: false };
  if (type.includes('set')) return { duckdbType: 'VARCHAR', isDefault: false };
  if (type.includes('json')) return { duckdbType: 'JSON', isDefault: false };
  if (type.includes('text')) return { duckdbType: 'TEXT', isDefault: false };
  if (type.includes('varchar') || type.includes('char')) return { duckdbType: 'VARCHAR', isDefault: false };
  if (type.includes('blob') || type.includes('binary')) return { duckdbType: 'BLOB', isDefault: false };

  // Timestamp and date types
  if (type.includes('timestamp')) return { duckdbType: 'TIMESTAMP', isDefault: false };
  if (type.includes('datetime')) return { duckdbType: 'TIMESTAMP', isDefault: false };
  if (type.includes('date')) return { duckdbType: 'DATE', isDefault: false };
  if (type.includes('time')) return { duckdbType: 'TIME', isDefault: false };

  // Numeric types
  if (type.includes('bigint')) return { duckdbType: 'BIGINT', isDefault: false };
  if (type.includes('tinyint')) return { duckdbType: 'TINYINT', isDefault: false };
  if (type.includes('smallint')) return { duckdbType: 'SMALLINT', isDefault: false };
  if (type.includes('mediumint')) return { duckdbType: 'BIGINT', isDefault: false };
  if (type.includes('int')) return { duckdbType: 'BIGINT', isDefault: false };
  if (type.includes('decimal') || type.includes('numeric')) return { duckdbType: 'DECIMAL', isDefault: false };
  if (type.includes('float')) return { duckdbType: 'FLOAT', isDefault: false };
  if (type.includes('double')) return { duckdbType: 'DOUBLE', isDefault: false };
  if (type.includes('boolean') || type.includes('bool')) return { duckdbType: 'BOOLEAN', isDefault: false };
  if (type.includes('bit')) return { duckdbType: 'VARCHAR', isDefault: false };

  // Fallback — truly unsupported type
  return { duckdbType: 'VARCHAR', isDefault: true };
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

export async function diagnoseDatabase(mysql: MySQLConnection): Promise<DiagnoseResult> {
  const serverChecks: DiagnoseCheck[] = [];

  // 1. Connection test
  try {
    await mysql.execute('SELECT 1');
    serverChecks.push({ name: 'Connection', status: 'pass', detail: 'OK' });
  } catch (err: any) {
    serverChecks.push({ name: 'Connection', status: 'fail', detail: err.message || 'Connection failed' });
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
    serverChecks.push({
      name: 'Server charset',
      status: charset === 'utf8mb4' ? 'pass' : 'warn',
      detail: charset === 'utf8mb4' ? charset : `${charset} — 4-byte emoji will be lost`,
    });
  }

  // 3. Server collation
  const collation = await getVariable(mysql, 'collation_server');
  if (collation) {
    serverChecks.push({
      name: 'Server collation',
      status: collation.startsWith('utf8mb4') ? 'pass' : 'warn',
      detail: collation,
    });
  }

  // 4. Binlog enabled
  const logBin = await getVariable(mysql, 'log_bin');
  if (logBin !== null) {
    serverChecks.push({
      name: 'Binlog enabled',
      status: logBin === 'ON' ? 'pass' : 'warn',
      detail: logBin === 'ON' ? 'ON' : 'OFF — CDC will not work',
    });
  }

  // 5. Binlog format
  const binlogFormat = await getVariable(mysql, 'binlog_format');
  if (binlogFormat !== null) {
    serverChecks.push({
      name: 'Binlog format',
      status: binlogFormat === 'ROW' ? 'pass' : 'warn',
      detail: binlogFormat === 'ROW' ? 'ROW' : `${binlogFormat} — CDC needs ROW format`,
    });
  }

  // 6. Binlog row image
  const binlogRowImage = await getVariable(mysql, 'binlog_row_image');
  if (binlogRowImage !== null) {
    serverChecks.push({
      name: 'Binlog row image',
      status: binlogRowImage === 'FULL' ? 'pass' : 'warn',
      detail: binlogRowImage === 'FULL' ? 'FULL' : `${binlogRowImage} — CDC may miss columns`,
    });
  }

  // 7. sql_mode zero dates
  try {
    const rows = await mysql.execute('SELECT @@sql_mode as mode');
    const sqlMode = rows[0]?.mode || '';
    const hasNoZeroDate = sqlMode.includes('NO_ZERO_DATE');
    serverChecks.push({
      name: 'Zero-date handling',
      status: hasNoZeroDate ? 'pass' : 'warn',
      detail: hasNoZeroDate ? 'NO_ZERO_DATE enabled' : 'NO_ZERO_DATE not set — zero dates may appear',
    });
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
        const { duckdbType, isDefault } = mapMySQLTypeToDuckDB(col.Type);
        if (isDefault) {
          unsupported.push({ column: col.Field, type: col.Type, mapping: duckdbType });
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
