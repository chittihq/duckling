/**
 * Type definitions for @vlasky/zongji
 * MySQL binlog parser for Node.js
 */

declare module '@vlasky/zongji' {
  import { EventEmitter } from 'events';

  interface ZongJiOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: {
      rejectUnauthorized?: boolean;
      ca?: string | Buffer;
      cert?: string | Buffer;
      key?: string | Buffer;
    };
    // Existing MySQL connection or pool
    connection?: any;
  }

  interface StartOptions {
    /** Unique server ID (1 to 2^32-1), must be unique among replication slaves */
    serverId?: number;
    /** Start from end of binlog (only new events) */
    startAtEnd?: boolean;
    /** Start from specific binlog file */
    filename?: string;
    /** Start from specific position in binlog file */
    position?: number;
    /** Event types to include */
    includeEvents?: string[];
    /** Event types to exclude */
    excludeEvents?: string[];
    /** Databases/tables to include: { dbName: true } or { dbName: ['table1', 'table2'] } */
    includeSchema?: { [key: string]: boolean | string[] };
    /** Databases/tables to exclude */
    excludeSchema?: { [key: string]: boolean | string[] };
  }

  interface BinlogEvent {
    /** Get event type name */
    getTypeName(): string;
    /** Get event name */
    getEventName(): string;
    /** Dump event to console */
    dump(): void;
    /** Binlog filename */
    binlogName?: string;
    /** Next position in binlog */
    nextPosition?: number;
    /** Table ID for row events */
    tableId?: number;
    /** Table map with schema info */
    tableMap?: {
      [tableId: number]: {
        tableName: string;
        parentSchema: string;
        columns: Array<{
          name: string;
          type: string;
          charset?: string;
          nullable: boolean;
        }>;
      };
    };
    /** Rows for WriteRows, UpdateRows, DeleteRows events */
    rows?: any[];
    /** SQL statement for Query events */
    query?: string;
    /** Timestamp */
    timestamp?: number;
  }

  class ZongJi extends EventEmitter {
    constructor(options: ZongJiOptions);

    /** Start receiving binlog events */
    start(options?: StartOptions): void;

    /** Stop receiving binlog events */
    stop(): void;

    /** Event: Connection ready */
    on(event: 'ready', listener: () => void): this;

    /** Event: Binlog event received */
    on(event: 'binlog', listener: (event: BinlogEvent) => void): this;

    /** Event: Error occurred */
    on(event: 'error', listener: (error: Error) => void): this;

    /** Event: Connection stopped */
    on(event: 'stopped', listener: () => void): this;
  }

  export = ZongJi;
}
