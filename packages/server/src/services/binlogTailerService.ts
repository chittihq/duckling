import { randomUUID } from 'crypto';
import ZongJi from '@vlasky/zongji';
import ClickHouseConnection from '../database/clickhouse';
import MySQLConnection from '../database/mysql';
import ClickHouseSyncService from './clickhouseSyncService';
import logger from '../logger';

/**
 * CDC-lite: a lightweight binlog tailer that AUGMENTS polling mode — it does
 * not replace the polling data path.
 *
 *  - DELETE row events  → tombstone rows (`_sync_deleted = 1`, dedup-key
 *    columns only) written into `<table>__raw`. The tombstone-aware
 *    projection view (dedup first, then delete-filter) makes the row vanish
 *    at read time. This closes polling mode's delete blind spot — a
 *    count-neutral delete+insert previously left the deleted row visible
 *    until the next full rebuild.
 *  - INSERT/UPDATE row events → debounced per-table incremental-sync nudges,
 *    so changes land at sync latency instead of waiting for row-count or
 *    change-token drift. The actual DATA still flows through the existing
 *    dump/sync path — a binlog decoding quirk can never corrupt values.
 *
 * Deliberately works with `binlog_row_metadata = MINIMAL` (the managed-MySQL
 * default that blocks full PeerDB CDC): zongji resolves column names from
 * information_schema, and tombstones only need the dedup-key columns, whose
 * shape effectively never changes. Requires only `log_bin = ON`,
 * `binlog_format = ROW`, and REPLICATION SLAVE/CLIENT grants.
 *
 * Checkpointing prefers the server's GTID set (survives binlog rotation and
 * failover; DO/RDS-style managed MySQL runs gtid_mode=ON) and falls back to
 * file+position. Stored under `<databaseId>::binlog-tailer` in
 * cdc_binlog_position so the poller's synthetic checkpoint is never
 * clobbered (that table is a ReplacingMergeTree keyed on database_id).
 *
 * Failure posture: best-effort. Any error degrades to pure polling (exactly
 * the pre-CDC-lite behavior) and reconnects with backoff. Deletes that
 * happen while the tailer is down are missed until a rebuild — same as
 * before this service existed.
 */

type TailerStatus = {
  running: boolean;
  gtidSet: string | null;
  binlogName: string | null;
  binlogPosition: number | null;
  tombstonesWritten: number;
  nudgesTriggered: number;
  reconnects: number;
  lastError: string | null;
  lastEventAt: string | null;
};

const CHECKPOINT_SUFFIX = '::binlog-tailer';
const GTID_CHECKPOINT_PREFIX = 'gtid:';

const NUDGE_DEBOUNCE_MS = 250;
const CHECKPOINT_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

class BinlogTailerService {
  private static instances: Map<string, BinlogTailerService> = new Map();

  private readonly databaseId: string;
  private readonly mysql: MySQLConnection;
  private readonly clickhouse: ClickHouseConnection;
  private readonly syncService: ClickHouseSyncService;

  private zongji: ZongJi | null = null;
  private running = false;
  private stopping = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private checkpointDirty = false;

  private dedupKeyCache: Map<string, string[]> = new Map();
  private noKeyWarned: Set<string> = new Set();
  private pendingNudges: Set<string> = new Set();
  private nudgeTimer: NodeJS.Timeout | null = null;
  private nudgeInFlight = false;

  private status: TailerStatus = {
    running: false,
    gtidSet: null,
    binlogName: null,
    binlogPosition: null,
    tombstonesWritten: 0,
    nudgesTriggered: 0,
    reconnects: 0,
    lastError: null,
    lastEventAt: null,
  };

  private constructor(
    databaseId: string,
    mysql: MySQLConnection,
    clickhouse: ClickHouseConnection,
    syncService: ClickHouseSyncService,
  ) {
    this.databaseId = databaseId;
    this.mysql = mysql;
    this.clickhouse = clickhouse;
    this.syncService = syncService;
  }

  static getInstance(
    databaseId: string,
    mysql: MySQLConnection,
    clickhouse: ClickHouseConnection,
    syncService: ClickHouseSyncService,
  ): BinlogTailerService {
    if (!BinlogTailerService.instances.has(databaseId)) {
      BinlogTailerService.instances.set(
        databaseId,
        new BinlogTailerService(databaseId, mysql, clickhouse, syncService),
      );
    }
    return BinlogTailerService.instances.get(databaseId)!;
  }

  static async closeInstance(databaseId: string): Promise<void> {
    const instance = BinlogTailerService.instances.get(databaseId);
    if (instance) {
      await instance.stop();
      BinlogTailerService.instances.delete(databaseId);
    }
  }

  getStatus(): TailerStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    // Existing tables predate the tombstone-aware view shape — refresh their
    // projection views once so tombstones can actually shadow live rows.
    try {
      const tables = await this.mysql.getTables();
      for (const table of tables) {
        await this.syncService.refreshProjectionView(table).catch((error) => {
          logger.warn(`CDC-lite: view refresh failed for ${table} on ${this.databaseId} (continuing):`, error);
        });
      }
    } catch (error) {
      logger.warn(`CDC-lite: view refresh sweep failed for ${this.databaseId} (continuing):`, error);
    }

    await this.connect();

    this.checkpointTimer = setInterval(() => {
      void this.persistCheckpoint();
    }, CHECKPOINT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.teardownZongji();
    await this.persistCheckpoint();
    this.status.running = false;
  }

  private teardownZongji(): void {
    if (!this.zongji) return;
    try {
      this.zongji.stop();
    } catch (error) {
      logger.warn(`CDC-lite: zongji stop failed for ${this.databaseId} (continuing):`, error);
    }
    this.zongji = null;
  }

  private async connect(): Promise<void> {
    const options = this.mysql.getConnectionOptions();
    const checkpoint = await this.loadCheckpoint();

    const zongji = new ZongJi({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      // Temporal values stay strings — tombstones only forward dedup-key
      // values, and strings avoid TZ round-trip surprises for datetime keys.
      dateStrings: true,
    });
    this.zongji = zongji;

    zongji.on('ready', () => {
      this.reconnectAttempts = 0;
      this.status.running = true;
    });

    zongji.on('binlog', (event: any) => {
      void this.handleEvent(event);
    });

    zongji.on('error', (error: Error) => {
      if (this.stopping) return;
      this.status.lastError = error.message;
      logger.warn(`CDC-lite: binlog stream error for ${this.databaseId}; pure polling until reconnect:`, error);
      this.scheduleReconnect();
    });

    const startOptions: Record<string, unknown> = {
      // 'query' carries DDL (ALTER/RENAME/TRUNCATE/DROP) — needed to
      // invalidate cached dedup keys on schema changes. Row events for
      // temporary tables and views never appear in ROW binlogs, so those
      // need no special handling.
      includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows', 'rotate', 'gtidlog', 'query'],
      includeSchema: { [options.database]: true },
      serverId: this.deriveServerId(),
    };

    if (checkpoint?.gtidSet !== undefined) {
      startOptions.gtidSet = checkpoint.gtidSet;
    } else if (checkpoint) {
      startOptions.filename = checkpoint.filename;
      startOptions.position = checkpoint.position;
    } else {
      startOptions.startAtEnd = true;
    }

    try {
      zongji.start(startOptions);
      logger.info(
        `CDC-lite: binlog tailer starting for ${this.databaseId} ` +
        (checkpoint?.gtidSet !== undefined
          ? 'from persisted GTID set'
          : checkpoint
            ? `at ${checkpoint.filename}:${checkpoint.position}`
            : 'from current position'),
      );
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      logger.warn(`CDC-lite: binlog tailer failed to start for ${this.databaseId}; polling continues unaided:`, error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.teardownZongji();
    this.status.running = false;
    this.reconnectAttempts += 1;
    this.status.reconnects += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 6), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      // A stored checkpoint can be invalid (binlog purged, corrupt GTID set);
      // after 2 consecutive failures drop it and resume from now.
      const dropCheckpoint = this.reconnectAttempts >= 2
        ? this.clearCheckpoint().catch(() => undefined)
        : Promise.resolve();
      void dropCheckpoint.then(() => this.connect());
    }, delay);
  }

  private async handleEvent(event: any): Promise<void> {
    try {
      const name = event.getEventName?.();
      if (!name) return;

      if (name === 'rotate') {
        this.status.binlogName = event.binlogName ?? this.status.binlogName;
        this.status.binlogPosition = Number(event.position ?? 0);
        this.checkpointDirty = true;
        return;
      }

      if (name === 'query') {
        // DDL invalidates cached schema knowledge: an ALTER can change the
        // PK/UNIQUE key a tombstone must carry. Cheap + safe: drop the whole
        // cache and let the next delete re-introspect. (TRUNCATE emits no
        // deleterows — the poller's count-drop rebuild handles it.)
        const query = String(event.query ?? '');
        if (/\b(ALTER|RENAME|TRUNCATE|DROP|CREATE)\b/i.test(query)) {
          this.dedupKeyCache.clear();
          this.noKeyWarned.clear();
        }
        return;
      }

      if (typeof event.nextPosition === 'number' && event.nextPosition > 0) {
        this.status.binlogPosition = event.nextPosition;
        this.checkpointDirty = true;
      }
      // Prefer GTID checkpointing when the server provides it.
      const gtidSet = this.zongji?.gtidSet;
      if (typeof gtidSet === 'string' && gtidSet.length > 0) {
        this.status.gtidSet = gtidSet;
        this.checkpointDirty = true;
      }
      this.status.lastEventAt = new Date().toISOString();

      const tableEntry = event.tableMap?.[event.tableId];
      const tableName: string | undefined = tableEntry?.tableName;
      if (!tableName) return;

      if (name === 'deleterows') {
        await this.writeTombstones(tableName, event.rows ?? []);
        return;
      }

      if (name === 'writerows' || name === 'updaterows') {
        this.queueNudge(tableName);
      }
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      logger.warn(`CDC-lite: event handling failed for ${this.databaseId} (continuing):`, error);
    }
  }

  private async writeTombstones(tableName: string, rows: Array<Record<string, unknown>>): Promise<void> {
    if (rows.length === 0) return;

    const dedupKey = await this.getDedupKeyColumns(tableName);
    if (dedupKey.length === 0) {
      if (!this.noKeyWarned.has(tableName)) {
        this.noKeyWarned.add(tableName);
        logger.warn(
          `CDC-lite: ${tableName} on ${this.databaseId} has no PK or UNIQUE key — ` +
          'deletes cannot be tombstoned (view has no dedup either); relying on count-drop rebuilds.',
        );
      }
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 23).replace('T', ' ');
    const batchId = `binlog-delete-${randomUUID()}`;
    const tombstones: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const tombstone: Record<string, unknown> = {
        _sync_batch_id: batchId,
        _sync_timestamp: timestamp,
        _sync_deleted: 1,
        _sync_schema_fingerprint: '',
      };
      let complete = true;
      for (const column of dedupKey) {
        const value = this.normalizeKeyValue(row[column]);
        if (value === undefined) {
          complete = false;
          break;
        }
        tombstone[column] = value;
      }
      if (complete) {
        tombstones.push(tombstone);
      } else {
        logger.warn(`CDC-lite: delete event for ${tableName} missing dedup-key column(s); skipping tombstone`);
      }
    }

    if (tombstones.length === 0) return;

    const columns = [...dedupKey, '_sync_batch_id', '_sync_timestamp', '_sync_deleted', '_sync_schema_fingerprint'];
    await this.clickhouse.insert(`${tableName}__raw`, tombstones, columns);
    this.status.tombstonesWritten += tombstones.length;
  }

  private normalizeKeyValue(value: unknown): unknown {
    if (value === undefined || value === null) return undefined;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Date) return value.toISOString().slice(0, 23).replace('T', ' ');
    if (typeof value === 'bigint') return value.toString();
    return value;
  }

  private async getDedupKeyColumns(tableName: string): Promise<string[]> {
    const cached = this.dedupKeyCache.get(tableName);
    if (cached) return cached;
    const primary = await this.mysql.getPrimaryKeyColumns(tableName);
    const key = primary.length > 0 ? primary : await this.mysql.getUniqueKeyColumns(tableName);
    this.dedupKeyCache.set(tableName, key);
    return key;
  }

  private queueNudge(tableName: string): void {
    this.pendingNudges.add(tableName);
    if (this.nudgeTimer || this.nudgeInFlight) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.flushNudges();
    }, NUDGE_DEBOUNCE_MS);
  }

  private async flushNudges(): Promise<void> {
    if (this.nudgeInFlight) return;
    this.nudgeInFlight = true;
    try {
      while (this.pendingNudges.size > 0) {
        const tables = Array.from(this.pendingNudges);
        this.pendingNudges.clear();
        for (const table of tables) {
          try {
            await this.syncService.syncSingleTable(table);
            this.status.nudgesTriggered += 1;
          } catch (error) {
            // The 1s poller remains the safety net; a failed nudge is not fatal.
            logger.warn(`CDC-lite: nudge sync failed for ${table} on ${this.databaseId} (poller will catch up):`, error);
          }
        }
      }
    } finally {
      this.nudgeInFlight = false;
    }
  }

  private checkpointKey(): string {
    return `${this.databaseId}${CHECKPOINT_SUFFIX}`;
  }

  private async loadCheckpoint(): Promise<{ gtidSet?: string; filename: string; position: number } | null> {
    try {
      const rows = await this.clickhouse.execute(
        `SELECT filename, position FROM cdc_binlog_position WHERE database_id = ? ORDER BY updated_at DESC LIMIT 1`,
        [this.checkpointKey()],
      );
      if (rows.length === 0) return null;
      const stored = typeof rows[0].filename === 'string' ? rows[0].filename : '';
      if (stored.startsWith(GTID_CHECKPOINT_PREFIX)) {
        return { gtidSet: stored.slice(GTID_CHECKPOINT_PREFIX.length), filename: '', position: 0 };
      }
      const position = Number(rows[0].position || 0);
      if (!stored || !Number.isFinite(position) || position <= 0) return null;
      return { filename: stored, position };
    } catch (error) {
      logger.warn(`CDC-lite: checkpoint load failed for ${this.databaseId} (starting from now):`, error);
      return null;
    }
  }

  private async persistCheckpoint(): Promise<void> {
    if (!this.checkpointDirty) return;
    const filename = this.status.gtidSet
      ? `${GTID_CHECKPOINT_PREFIX}${this.status.gtidSet}`
      : this.status.binlogName;
    const position = this.status.gtidSet ? 0 : this.status.binlogPosition;
    if (!filename) return;
    this.checkpointDirty = false;
    try {
      await this.clickhouse.insert('cdc_binlog_position', [{
        database_id: this.checkpointKey(),
        filename,
        position: position ?? 0,
        updated_at: new Date().toISOString().slice(0, 23).replace('T', ' '),
      }]);
    } catch (error) {
      this.checkpointDirty = true;
      logger.warn(`CDC-lite: checkpoint persist failed for ${this.databaseId} (will retry):`, error);
    }
  }

  private async clearCheckpoint(): Promise<void> {
    this.status.gtidSet = null;
    this.status.binlogName = null;
    this.status.binlogPosition = null;
    this.checkpointDirty = false;
    await this.clickhouse.run(
      `ALTER TABLE cdc_binlog_position DELETE WHERE database_id = ?`,
      [this.checkpointKey()],
    ).catch(() => undefined);
  }

  /** Stable per-database replica server id in a private-ish range. */
  private deriveServerId(): number {
    let hash = 0;
    for (const char of this.databaseId) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return 45_000 + (hash % 10_000);
  }
}

export default BinlogTailerService;
