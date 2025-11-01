#!/usr/bin/env node

const mysql = require('mysql2/promise');
require('dotenv').config();

/**
 * MySQL Query CLI Tool
 * Usage: node mysql.js "SELECT * FROM User LIMIT 10"
 *
 * Executes SQL queries against MySQL database using MYSQL_CONNECTION_STRING
 * Returns results as JSON to stdout
 */

async function executeQuery(sql) {
  let connection;

  try {
    // Check if connection string is provided
    if (!process.env.MYSQL_CONNECTION_STRING) {
      throw new Error('MYSQL_CONNECTION_STRING environment variable is not set');
    }

    // Create connection
    connection = await mysql.createConnection(process.env.MYSQL_CONNECTION_STRING);

    // Execute query
    const [rows] = await connection.execute(sql);

    // Convert BigInt values to strings for JSON serialization
    const serializedRows = JSON.parse(
      JSON.stringify(rows, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    );

    // Output results as JSON
    console.log(JSON.stringify(serializedRows, null, 2));

    // Exit successfully
    process.exit(0);
  } catch (error) {
    // Output error to stderr
    console.error(JSON.stringify({
      success: false,
      error: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    }, null, 2));

    // Exit with error code
    process.exit(1);
  } finally {
    // Always close connection
    if (connection) {
      await connection.end();
    }
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(JSON.stringify({
    success: false,
    error: 'No SQL query provided',
    usage: 'node mysql.js "SELECT * FROM table_name"',
    example: 'node mysql.js "SELECT * FROM User LIMIT 10"'
  }, null, 2));
  process.exit(1);
}

// Join all arguments as the SQL query (in case query contains spaces)
const sql = args.join(' ');

executeQuery(sql);
