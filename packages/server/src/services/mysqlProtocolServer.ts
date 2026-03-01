/**
 * MySQL Wire Protocol Server
 *
 * Implements a MySQL-compatible server using mysql2's built-in server support.
 * Clients (mysql CLI, mysql2, Sequelize, phpMyAdmin, DBeaver, etc.) can connect
 * on a dedicated TCP port and run read-only queries against the replicated DuckDB data.
 *
 * Architecture:
 *   TCP connection → mysql2 wire protocol → SQL router → DuckDB query → MySQL result format
 */

import DuckDBConnection from '../database/duckdb';
import { DatabaseConfigManager } from '../database/databaseConfig';
import { routeQuery } from './mysqlQueryRouter';
import {
  buildColumnDefinition,
  formatValue,
  type MySQLColumnDefinition,
} from './mysqlResultFormatter';
import config from '../config';
import logger from '../logger';
import * as crypto from 'crypto';

// mysql2 is CommonJS — use require for the server-side API
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mysql2 = require('mysql2');

/* ------------------------------------------------------------------ */
/*  MySQL auth_41 helpers (inlined to avoid internal mysql2 imports)    */
/* ------------------------------------------------------------------ */

function sha1(...buffers: Buffer[]): Buffer {
  const hash = crypto.createHash('sha1');
  for (const buf of buffers) hash.update(buf);
  return hash.digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) result[i] = a[i] ^ b[i];
  return result;
}

function doubleSha1(password: string): Buffer {
  return sha1(sha1(Buffer.from(password)));
}

function verifyToken(
  publicSeed1: Buffer,
  publicSeed2: Buffer,
  token: Buffer,
  doubleSha: Buffer,
): boolean {
  const seed1 = publicSeed1.slice(0, 8);
  const seed2 = publicSeed2.slice(0, 12);
  const hashStage1 = xor(token, sha1(seed1, seed2, doubleSha));
  const candidateHash2 = sha1(hashStage1);
  return candidateHash2.compare(doubleSha) === 0;
}

/* ------------------------------------------------------------------ */
/*  MySQL client capability flags (from protocol spec)                 */
/* ------------------------------------------------------------------ */

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_FOUND_ROWS = 0x00000002;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_NO_SCHEMA = 0x00000010;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;

/* ------------------------------------------------------------------ */
/*  Connection state                                                   */
/* ------------------------------------------------------------------ */

interface ConnectionState {
  id: number;
  databaseId: string;
  user: string;
  remoteAddress: string;
  connectedAt: Date;
  lastActivity: Date;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/* ------------------------------------------------------------------ */
/*  MySQLProtocolServer                                                */
/* ------------------------------------------------------------------ */

export class MySQLProtocolServer {
  private server: any = null;
  private connections: Map<number, ConnectionState> = new Map();
  private nextConnectionId = 1;
  private readonly port: number;
  private readonly maxConnections: number;
  private readonly username: string;
  private readonly password: string;
  private readonly defaultDatabase: string;
  private passwordDoubleSha1: Buffer | null = null;

  constructor() {
    this.port = config.mysqlProtocol.port;
    this.maxConnections = config.mysqlProtocol.maxConnections;
    this.username = config.mysqlProtocol.username;
    this.password = config.mysqlProtocol.password;
    this.defaultDatabase = config.mysqlProtocol.defaultDatabase;

    // Pre-compute double SHA1 of the password for auth verification
    if (this.password) {
      this.passwordDoubleSha1 = doubleSha1(this.password);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = mysql2.createServer();

        this.server.on('connection', (conn: any) => {
          this.handleConnection(conn);
        });

        this.server.listen(this.port, () => {
          logger.info(`MySQL protocol server listening on port ${this.port}`);
          resolve();
        });

        // Propagate listen errors
        this.server._server.on('error', (err: Error) => {
          logger.error('MySQL protocol server error:', err);
          reject(err);
        });
      } catch (err) {
        logger.error('Failed to start MySQL protocol server:', err);
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      // Close all active connections
      for (const [, state] of this.connections) {
        if (state.idleTimer) clearTimeout(state.idleTimer);
      }
      this.connections.clear();

      this.server.close(() => {
        clearTimeout(forceTimer);
        logger.info('MySQL protocol server stopped');
        resolve();
      });

      // Force close after 5 seconds
      const forceTimer = setTimeout(() => {
        logger.warn('Forcing MySQL protocol server close after timeout');
        resolve();
      }, 5000);
    });
  }

  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  /* ---------------------------------------------------------------- */
  /*  Connection handling                                              */
  /* ---------------------------------------------------------------- */

  private handleConnection(conn: any): void {
    const connectionId = this.nextConnectionId++;

    // Enforce connection limit
    if (this.connections.size >= this.maxConnections) {
      logger.warn(`MySQL protocol: connection limit reached (${this.maxConnections})`);
      try {
        conn.writeError({
          code: 1040,
          message: 'Too many connections',
        });
      } catch (_) { /* ignore */ }
      try { conn.close(); } catch (_) { /* ignore */ }
      return;
    }

    // Initiate MySQL handshake
    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.32-Duckling',
      connectionId,
      statusFlags: 2, // SERVER_STATUS_AUTOCOMMIT
      characterSet: 45, // utf8mb4_general_ci
      capabilityFlags: this.buildCapabilityFlags(),
      authCallback: (params: any, cb: (err: any, mysqlError?: any) => void) => {
        this.authenticate(params, connectionId, conn, cb);
      },
    });

    // Query handler
    conn.on('query', (sql: string) => {
      this.handleQuery(conn, connectionId, sql);
    });

    // USE <database>
    conn.on('init_db', (schemaName: string) => {
      this.handleInitDb(conn, connectionId, schemaName);
    });

    // PING → OK
    conn.on('ping', () => {
      this.touchConnection(connectionId);
      try { conn.writeOk(); } catch (_) { /* ignore */ }
    });

    // Connection closed
    conn.on('quit', () => {
      this.removeConnection(connectionId);
      try { conn.stream.end(); } catch (_) { /* ignore */ }
    });

    conn.on('end', () => {
      this.removeConnection(connectionId);
    });

    conn.on('error', (err: Error) => {
      logger.debug(`MySQL protocol connection ${connectionId} error: ${err.message}`);
      this.removeConnection(connectionId);
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Authentication                                                   */
  /* ---------------------------------------------------------------- */

  private authenticate(
    params: any,
    connectionId: number,
    conn: any,
    cb: (err: any, mysqlError?: any) => void,
  ): void {
    const { user, database, address, authPluginData1, authPluginData2, authToken } = params;

    // Check username
    if (user !== this.username) {
      logger.warn(`MySQL protocol: rejected user '${user}' from ${address}`);
      cb(null, { code: 1045, message: `Access denied for user '${user}'` });
      return;
    }

    // Verify password using mysql_native_password (AUTH 41)
    if (this.passwordDoubleSha1 && authToken && authToken.length > 0) {
      const isValid = verifyToken(
        authPluginData1,
        authPluginData2,
        authToken,
        this.passwordDoubleSha1,
      );
      if (!isValid) {
        logger.warn(`MySQL protocol: invalid password for user '${user}' from ${address}`);
        cb(null, { code: 1045, message: `Access denied for user '${user}'` });
        return;
      }
    }

    // Resolve initial database
    let databaseId = this.defaultDatabase;
    if (database) {
      const dbConfig = DatabaseConfigManager.getInstance().getDatabase(database);
      if (!dbConfig) {
        cb(null, { code: 1049, message: `Unknown database '${database}'` });
        return;
      }
      databaseId = database;
    }

    // Register connection
    const state: ConnectionState = {
      id: connectionId,
      databaseId,
      user,
      remoteAddress: address || 'unknown',
      connectedAt: new Date(),
      lastActivity: new Date(),
      idleTimer: null,
    };
    this.connections.set(connectionId, state);
    this.resetIdleTimer(connectionId, conn);

    logger.info(`MySQL protocol: user '${user}' connected from ${address} (connId=${connectionId}, db=${databaseId})`);
    cb(null); // success — no error
  }

  /* ---------------------------------------------------------------- */
  /*  Query execution                                                  */
  /* ---------------------------------------------------------------- */

  private async handleQuery(conn: any, connectionId: number, sql: string): Promise<void> {
    this.touchConnection(connectionId);

    const state = this.connections.get(connectionId);
    if (!state) {
      try {
        conn.writeError({ code: 1053, message: 'Server shutdown in progress' });
      } catch (_) { /* ignore */ }
      return;
    }

    const dbManager = DatabaseConfigManager.getInstance();
    const databases = dbManager.getAllDatabases().map(d => d.id);

    try {
      const result = routeQuery(sql, connectionId, state.databaseId, state.user, databases);

      switch (result.type) {
        case 'ok':
          conn.writeOk();
          break;

        case 'error':
          conn.writeError({ code: result.code, message: result.message });
          break;

        case 'intercepted':
          this.writeResultSet(conn, result.columns, result.rows);
          break;

        case 'forward':
          await this.executeDuckDBQuery(conn, state, result.sql);
          break;
      }
    } catch (err: any) {
      logger.error(`MySQL protocol query error (connId=${connectionId}):`, {
        sql: sql.substring(0, 200),
        error: err.message,
      });
      try {
        conn.writeError({
          code: 1105, // ER_UNKNOWN_ERROR
          message: err.message || 'Internal error',
        });
      } catch (_) { /* ignore */ }
    }
  }

  private async executeDuckDBQuery(conn: any, state: ConnectionState, sql: string): Promise<void> {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(state.databaseId);
    if (!dbConfig) {
      conn.writeError({ code: 1049, message: `Unknown database '${state.databaseId}'` });
      return;
    }

    // Resolve DuckDB path (same logic as server.ts)
    let resolvedDuckdbPath = dbConfig.duckdbPath;
    if (resolvedDuckdbPath.startsWith('data/')) {
      resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
    }

    const duckdb = DuckDBConnection.getInstance(state.databaseId, resolvedDuckdbPath);

    const { rows, columnNames, columnTypes } = await duckdb.executeWithMetadata(sql);

    // Build MySQL column definitions
    const columns = columnNames.map((name: string, i: number) =>
      buildColumnDefinition(name, columnTypes[i]),
    );

    // Format rows: convert each value to string|null
    const formattedRows = rows.map((row: any[]) =>
      row.map((val: any) => formatValue(val)),
    );

    this.writeResultSet(conn, columns, formattedRows);
  }

  /* ---------------------------------------------------------------- */
  /*  USE <database>                                                   */
  /* ---------------------------------------------------------------- */

  private handleInitDb(conn: any, connectionId: number, schemaName: string): void {
    this.touchConnection(connectionId);

    const state = this.connections.get(connectionId);
    if (!state) {
      try { conn.writeError({ code: 1053, message: 'Server shutdown in progress' }); } catch (_) { /* ignore */ }
      return;
    }

    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(schemaName);
    if (!dbConfig) {
      try { conn.writeError({ code: 1049, message: `Unknown database '${schemaName}'` }); } catch (_) { /* ignore */ }
      return;
    }

    state.databaseId = schemaName;
    logger.debug(`MySQL protocol: connection ${connectionId} switched to database '${schemaName}'`);
    try { conn.writeOk(); } catch (_) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- */
  /*  Result writing helpers                                           */
  /* ---------------------------------------------------------------- */

  private writeResultSet(
    conn: any,
    columns: MySQLColumnDefinition[],
    rows: (string | null)[][],
  ): void {
    // Write column definitions
    conn.writeColumns(columns);
    // Write each row
    for (const row of rows) {
      conn.writeTextRow(row);
    }
    conn.writeEof();
  }

  /* ---------------------------------------------------------------- */
  /*  Connection management                                            */
  /* ---------------------------------------------------------------- */

  private touchConnection(connectionId: number): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.lastActivity = new Date();
    }
  }

  private resetIdleTimer(connectionId: number, conn: any): void {
    const state = this.connections.get(connectionId);
    if (!state) return;

    if (state.idleTimer) clearTimeout(state.idleTimer);

    // Default idle timeout: 28800 seconds (8 hours)
    const timeoutMs = 28800 * 1000;
    state.idleTimer = setTimeout(() => {
      logger.info(`MySQL protocol: closing idle connection ${connectionId}`);
      this.removeConnection(connectionId);
      try {
        conn.writeError({ code: 1205, message: 'Connection idle timeout' });
        conn.close();
      } catch (_) { /* ignore */ }
    }, timeoutMs);
  }

  private removeConnection(connectionId: number): void {
    const state = this.connections.get(connectionId);
    if (state) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      this.connections.delete(connectionId);
      logger.debug(`MySQL protocol: connection ${connectionId} removed`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Capability flags                                                 */
  /* ---------------------------------------------------------------- */

  private buildCapabilityFlags(): number {
    return (
      CLIENT_LONG_PASSWORD |
      CLIENT_FOUND_ROWS |
      CLIENT_LONG_FLAG |
      CLIENT_CONNECT_WITH_DB |
      CLIENT_NO_SCHEMA |
      CLIENT_PROTOCOL_41 |
      CLIENT_TRANSACTIONS |
      CLIENT_SECURE_CONNECTION |
      CLIENT_MULTI_RESULTS |
      CLIENT_PLUGIN_AUTH |
      CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
    );
  }
}

export default MySQLProtocolServer;
