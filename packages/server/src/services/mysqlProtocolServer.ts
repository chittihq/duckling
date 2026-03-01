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
  formatValueByType,
  type MySQLColumnDefinition,
} from './mysqlResultFormatter';
import config from '../config';
import logger from '../logger';
import * as crypto from 'crypto';
import * as path from 'path';

// mysql2 is CommonJS — use require for the server-side API
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mysql2 = require('mysql2');

/* ------------------------------------------------------------------ */
/*  Monkey-patch: sanitize client handshake flags before mysql2 parses */
/*  them. Some clients (notably TablePlus) send flags/features that    */
/*  mysql2's server-side parser does not robustly handle here, causing */
/*  readLengthCodedNumberExt errors during auth/connect-attrs parsing. */
/* ------------------------------------------------------------------ */
try {
  const mysql2EntryPath = require.resolve('mysql2');
  const mysql2Root = path.dirname(mysql2EntryPath);
  const handshakeResponsePath = path.join(mysql2Root, 'lib/packets/handshake_response.js');
  const packetPath = path.join(mysql2Root, 'lib/packets/packet.js');
  const serverHandshakePath = path.join(mysql2Root, 'lib/commands/server_handshake.js');

  const HandshakeResponse = require(handshakeResponsePath);
  const Packet = require(packetPath);
  const ServerHandshake = require(serverHandshakePath);
  const origFromPacket = HandshakeResponse.fromPacket;
  const origReadLengthCodedNumberExt = Packet.prototype.readLengthCodedNumberExt;
  const origReadClientReply = ServerHandshake.prototype.readClientReply;

  Packet.prototype.readLengthCodedNumberExt = function patchedReadLengthCodedNumberExt(
    this: any,
    tag: number,
    bigNumberStrings: unknown,
    signed: unknown,
  ) {
    const isKnownTag = tag === 0xfb || tag === 0xfc || tag === 0xfd || tag === 0xfe;
    if (!isKnownTag) {
      const offset = typeof this?.offset === 'number' ? this.offset - 1 : 'unknown';
      const start = typeof this?.start === 'number' ? this.start : 0;
      const end = typeof this?.end === 'number' ? this.end : 0;
      const payloadBytes = Math.max(end - (start + 4), 0);
      const remaining = typeof this?.offset === 'number' ? Math.max(end - this.offset, 0) : 0;

      logger.warn(
        `MySQL protocol parse anomaly: invalid length-coded number tag=${String(tag)} ` +
        `(payloadBytes=${payloadBytes}, offset=${offset}, remaining=${remaining})`,
      );
      throw new Error(
        `Invalid length-coded number tag ${String(tag)} at offset ${offset} (remaining=${remaining})`,
      );
    }

    return origReadLengthCodedNumberExt.call(this, tag, bigNumberStrings, signed);
  };

  HandshakeResponse.fromPacket = function patchedFromPacket(packet: any) {
    const payloadStart = (typeof packet?.start === 'number' ? packet.start : 0) + 4;
    const payloadEnd = typeof packet?.end === 'number'
      ? packet.end
      : (packet?.buffer?.length || payloadStart);
    const payloadBytes = Math.max(payloadEnd - payloadStart, 0);

    let flags: number | null = null;
    let sanitizedFlags: number | null = null;

    if (packet?.buffer && packet.buffer.length >= payloadStart + 4) {
      flags = packet.buffer.readUInt32LE(payloadStart);
      sanitizedFlags =
        flags &
        ~CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA &
        ~CLIENT_CONNECT_ATTRS;
      if (sanitizedFlags !== flags) {
        packet.buffer.writeUInt32LE(sanitizedFlags, payloadStart);
        logger.debug(
          `MySQL protocol handshake flags sanitized ${formatCapabilityFlags(flags)} -> ` +
          `${formatCapabilityFlags(sanitizedFlags)} ` +
          `(removed=${describeCapabilityFlags(flags ^ sanitizedFlags).join(',') || 'none'}, ` +
          `payloadBytes=${payloadBytes})`,
        );
      }
    }

    try {
      return origFromPacket.call(this, packet);
    } catch (error) {
      const offset = typeof packet?.offset === 'number'
        ? packet.offset - payloadStart
        : null;
      const remaining = typeof packet?.offset === 'number'
        ? Math.max(payloadEnd - packet.offset, 0)
        : null;
      const nextByte = typeof packet?.offset === 'number' &&
        packet?.buffer &&
        packet.offset >= 0 &&
        packet.offset < packet.buffer.length
        ? packet.buffer[packet.offset]
        : null;

      logger.error(
        `MySQL protocol handshake parse failure: ` +
        `${error instanceof Error ? error.message : String(error)} ` +
        `(payloadBytes=${payloadBytes}, offset=${offset ?? 'n/a'}, ` +
        `remaining=${remaining ?? 'n/a'}, nextByte=${nextByte ?? 'n/a'}, ` +
        `flags=${flags === null ? 'n/a' : formatCapabilityFlags(flags)}, ` +
        `sanitizedFlags=${sanitizedFlags === null ? 'n/a' : formatCapabilityFlags(sanitizedFlags)})`,
      );
      throw error;
    }
  };

  ServerHandshake.prototype.readClientReply = function patchedReadClientReply(
    packet: any,
    connection: any,
  ) {
    const next = origReadClientReply.call(this, packet, connection);
    if (typeof connection?._resetSequenceId === 'function') {
      connection._resetSequenceId();
    }
    return next;
  };

  logger.info(
    `MySQL protocol handshake compatibility patch installed ` +
    `(mysql2=${mysql2EntryPath})`,
  );
} catch (error) {
  logger.warn(
    `MySQL protocol handshake compatibility patch not applied: ` +
    `${error instanceof Error ? error.message : String(error)}`,
  );
}

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
const CLIENT_SSL = 0x00000800;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_ATTRS = 0x00100000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;

function formatCapabilityFlags(flags: number): string {
  return `0x${flags.toString(16).padStart(8, '0')}`;
}

function describeCapabilityFlags(flags: number): string[] {
  if (!flags) return [];

  const knownFlags: Array<[string, number]> = [
    ['LONG_PASSWORD', CLIENT_LONG_PASSWORD],
    ['FOUND_ROWS', CLIENT_FOUND_ROWS],
    ['LONG_FLAG', CLIENT_LONG_FLAG],
    ['CONNECT_WITH_DB', CLIENT_CONNECT_WITH_DB],
    ['NO_SCHEMA', CLIENT_NO_SCHEMA],
    ['PROTOCOL_41', CLIENT_PROTOCOL_41],
    ['SSL', CLIENT_SSL],
    ['TRANSACTIONS', CLIENT_TRANSACTIONS],
    ['SECURE_CONNECTION', CLIENT_SECURE_CONNECTION],
    ['MULTI_RESULTS', CLIENT_MULTI_RESULTS],
    ['PLUGIN_AUTH', CLIENT_PLUGIN_AUTH],
    ['CONNECT_ATTRS', CLIENT_CONNECT_ATTRS],
    ['PLUGIN_AUTH_LENENC_CLIENT_DATA', CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA],
  ];

  return knownFlags
    .filter(([, value]) => (flags & value) !== 0)
    .map(([name]) => name);
}

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

function compactSqlForLog(sql: string, maxLen = 300): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.substring(0, maxLen)}...`;
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
    const remote = conn?.stream?.remoteAddress || 'unknown';
    logger.debug(`MySQL protocol: incoming connection ${connectionId} from ${remote}`);

    // Enforce connection limit
    if (this.connections.size >= this.maxConnections) {
      logger.warn(`MySQL protocol: connection limit reached (${this.maxConnections})`);
      try {
        conn.writeError({
          code: 1040,
          message: 'Too many connections',
        });
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
      try { conn.close(); } catch (_) { /* ignore */ }
      return;
    }

    // Catch protocol-level parse errors (e.g. unsupported auth plugins)
    // so they don't produce ugly stack traces in the logs.
    conn.on('error', (err: Error) => {
      logger.debug(`MySQL protocol connection ${connectionId} error: ${err.message}`);
      this.removeConnection(connectionId);
    });
    conn.on('warn', (warn: any) => {
      const expected = typeof warn?.expected === 'number' ? warn.expected : 'unknown';
      const received = typeof warn?.received === 'number' ? warn.received : 'unknown';
      logger.warn(
        `MySQL protocol sequence warning on connection ${connectionId}: ` +
        `expected=${expected}, received=${received}, message=${warn?.message || 'unknown'}`,
      );
    });

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

    // Prepared statements are not yet supported by this protocol adapter.
    conn.on('stmt_prepare', (sql: string) => {
      logger.debug(
        `MySQL protocol: stmt_prepare not supported ` +
        `(connId=${connectionId}, db=${this.connections.get(connectionId)?.databaseId || 'n/a'}, ` +
        `sql="${compactSqlForLog(sql)}")`,
      );
      try {
        conn.writeError({
          code: 1295, // ER_UNSUPPORTED_PS
          message: 'Prepared statements are not supported by Duckling MySQL protocol',
        });
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
    });
    conn.on('stmt_execute', (stmtId: number, _flags: any, _iterationCount: any, _values: any) => {
      logger.debug(
        `MySQL protocol: stmt_execute not supported ` +
        `(connId=${connectionId}, stmtId=${String(stmtId)})`,
      );
      try {
        conn.writeError({
          code: 1295, // ER_UNSUPPORTED_PS
          message: 'Prepared statements are not supported by Duckling MySQL protocol',
        });
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
    });

    // USE <database>
    conn.on('init_db', (schemaName: string) => {
      this.handleInitDb(conn, connectionId, schemaName);
    });

    // PING → OK
    conn.on('ping', () => {
      this.touchConnection(connectionId);
      try {
        conn.writeOk();
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
    });

    // Connection closed
    conn.on('quit', () => {
      this.removeConnection(connectionId);
      try { conn.stream.end(); } catch (_) { /* ignore */ }
    });

    conn.on('end', () => {
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
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
      return;
    }

    const dbManager = DatabaseConfigManager.getInstance();
    const databases = dbManager.getAllDatabases().map(d => d.id);

    logger.debug(
      `MySQL protocol query received ` +
      `(connId=${connectionId}, db=${state.databaseId}, sql="${compactSqlForLog(sql)}")`,
    );

    try {
      const result = routeQuery(sql, connectionId, state.databaseId, state.user, databases);
      logger.debug(
        `MySQL protocol query routed ` +
        `(connId=${connectionId}, db=${state.databaseId}, route=${result.type})`,
      );

      switch (result.type) {
        case 'ok':
          conn.writeOk();
          this.resetCommandSequence(conn);
          break;

        case 'error':
          conn.writeError({ code: result.code, message: result.message });
          this.resetCommandSequence(conn);
          break;

        case 'intercepted':
          this.writeResultSet(conn, result.columns, result.rows);
          logger.debug(
            `MySQL protocol intercepted result ` +
            `(connId=${connectionId}, cols=${result.columns.length}, rows=${result.rows.length})`,
          );
          break;

        case 'forward':
          await this.executeDuckDBQuery(conn, state, result.sql);
          logger.debug(
            `MySQL protocol forwarded query executed ` +
            `(connId=${connectionId}, db=${state.databaseId})`,
          );
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
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
    }
  }

  private async executeDuckDBQuery(conn: any, state: ConnectionState, sql: string): Promise<void> {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(state.databaseId);
    if (!dbConfig) {
      conn.writeError({ code: 1049, message: `Unknown database '${state.databaseId}'` });
      this.resetCommandSequence(conn);
      return;
    }

    // Resolve DuckDB path (same logic as server.ts)
    let resolvedDuckdbPath = dbConfig.duckdbPath;
    if (resolvedDuckdbPath.startsWith('data/')) {
      resolvedDuckdbPath = `/app/${resolvedDuckdbPath}`;
    }

    const duckdb = DuckDBConnection.getInstance(state.databaseId, resolvedDuckdbPath);

    const { rows, columnNames, columnTypes } = await duckdb.executeWithMetadata(sql);
    logger.debug(
      `MySQL protocol DuckDB query result ` +
      `(db=${state.databaseId}, cols=${columnNames.length}, rows=${rows.length}, sql="${compactSqlForLog(sql)}")`,
    );

    // Build MySQL column definitions
    const columns = columnNames.map((name: string, i: number) =>
      buildColumnDefinition(name, columnTypes[i]),
    );

    // Format rows: convert each value to string|null
    const formattedRows = rows.map((row: any[]) =>
      row.map((val: any, i: number) => formatValueByType(val, columnTypes[i])),
    );

    this.writeResultSet(conn, columns, formattedRows);
  }

  /* ---------------------------------------------------------------- */
  /*  USE <database>                                                   */
  /* ---------------------------------------------------------------- */

  private handleInitDb(conn: any, connectionId: number, schemaName: string): void {
    this.touchConnection(connectionId);
    logger.debug(
      `MySQL protocol init_db requested ` +
      `(connId=${connectionId}, schema="${schemaName}")`,
    );

    const state = this.connections.get(connectionId);
    if (!state) {
      try {
        conn.writeError({ code: 1053, message: 'Server shutdown in progress' });
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
      return;
    }

    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(schemaName);
    if (!dbConfig) {
      try {
        conn.writeError({ code: 1049, message: `Unknown database '${schemaName}'` });
        this.resetCommandSequence(conn);
      } catch (_) { /* ignore */ }
      return;
    }

    state.databaseId = schemaName;
    logger.debug(`MySQL protocol: connection ${connectionId} switched to database '${schemaName}'`);
    try {
      conn.writeOk();
      this.resetCommandSequence(conn);
    } catch (_) { /* ignore */ }
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
    this.resetCommandSequence(conn);
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
        this.resetCommandSequence(conn);
        conn.close();
      } catch (_) { /* ignore */ }
    }, timeoutMs);
  }

  private resetCommandSequence(conn: any): void {
    if (typeof conn?._resetSequenceId === 'function') {
      conn._resetSequenceId();
      return;
    }
    conn.sequenceId = 0;
    conn.compressedSequenceId = 0;
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
    // Note: CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA is intentionally excluded —
    // mysql2's server-side parser cannot handle length-encoded auth data from
    // clients like TablePlus, causing readLengthCodedNumberExt crashes.
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
      CLIENT_PLUGIN_AUTH
    );
  }
}

export default MySQLProtocolServer;
