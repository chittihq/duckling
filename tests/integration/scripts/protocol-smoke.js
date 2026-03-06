/**
 * MySQL Protocol Smoke Test
 *
 * Connects to the Duckling MySQL protocol adapter and runs representative
 * GUI-client queries to verify protocol compatibility.
 *
 * Usage (inside the duckling container):
 *   node scripts/protocol-smoke.js
 */
import mysql from 'mysql2/promise';

const dbId = process.env.DUCKLING_TEST_DB_ID || 'integration';
const protocolPort = Number(process.env.MYSQL_PROTOCOL_PORT || '3307');

const queries = [
  'SHOW DATABASES',
  "SHOW DATABASES LIKE 'i%'",
  "SELECT SCHEMA_NAME AS DatabaseName FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME",
  `SELECT ROUTINE_SCHEMA as function_schema,ROUTINE_NAME as function_name,ROUTINE_DEFINITION as create_statement,ROUTINE_TYPE as function_type FROM information_schema.routines where ROUTINE_SCHEMA='${dbId}'`,
  `SELECT data_length AS data_size, index_length AS index_size, (data_length + index_length) AS total_size, table_comment AS comment FROM information_schema.TABLES WHERE table_schema = '${dbId}' AND table_name = 'users_with_timestamps'`,
  `SELECT column_name as column_name FROM information_schema.statistics WHERE table_schema = '${dbId}' AND table_name = 'users_with_timestamps' AND index_name = 'PRIMARY' ORDER BY seq_in_index ASC`,
  `SELECT table_name as table_name,column_name as column_name,column_type as column_type FROM information_schema.columns WHERE table_schema='${dbId}' AND table_name='users_with_timestamps' AND data_type='enum'`,
  `SELECT ordinal_position as ordinal_position,column_name as column_name,column_type AS data_type,character_set_name as character_set,collation_name as collation,is_nullable as is_nullable,column_default as column_default,extra as extra,column_name AS foreign_key,column_comment AS comment FROM information_schema.columns WHERE table_schema='${dbId}' AND table_name='users_with_timestamps'`,
  `SELECT * FROM \`${dbId}\`.\`users_with_timestamps\` LIMIT 3 OFFSET 0`,
  `SELECT table_rows as count FROM information_schema.TABLES WHERE TABLE_SCHEMA='${dbId}' AND TABLE_NAME='users_with_timestamps'`,
  `SELECT COUNT(*) as count FROM \`${dbId}\`.\`users_with_timestamps\``,
];

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: protocolPort,
    user: process.env.MYSQL_PROTOCOL_USER || 'duckling',
    password: process.env.MYSQL_PROTOCOL_PASSWORD || process.env.DUCKLING_API_KEY || 'integration-test-key',
    database: dbId,
  });

  try {
    for (const sql of queries) {
      const [rows] = await conn.query(sql);
      const rowCount = Array.isArray(rows) ? rows.length : 0;
      console.log(`[protocol-smoke] OK rows=${rowCount} sql=${sql.slice(0, 120)}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(`[protocol-smoke] FAIL ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
