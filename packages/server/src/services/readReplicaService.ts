/**
 * Read Replica Service
 *
 * Provides optional read-only replica support for DuckDB.
 * Periodically snapshots the primary database file and opens it in
 * READ_ONLY mode. API queries can be routed to the replica to avoid
 * interference with write operations (sync, CDC).
 *
 * Trade-offs:
 * - Queries see data stale by up to REPLICA_REFRESH_INTERVAL seconds
 * - Requires ~2x disk space during copy
 * - For a 200GB database, copy takes ~60-90 seconds on SSD
 * - Replica refresh is atomic (rename) — queries never see a partial file
 *
 * DuckDB constraint: Within a single process, read + write use MVCC
 * (no conflict for separate tables). Across processes, all must open
 * in READ_ONLY mode. This service creates a read-only *copy* of the
 * database file within the same process, opened via a separate
 * DuckDBInstance in READ_ONLY mode, providing isolation without
 * requiring a separate OS process.
 *
 * Environment:
 *   READ_REPLICA_ENABLED  — Enable read replica mode (default: false)
 *   REPLICA_REFRESH_INTERVAL — Seconds between snapshots (default: 300)
 */

import { DuckDBInstance } from '@duckdb/node-api';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import logger from '../logger';

export interface ReplicaStatus {
  enabled: boolean;
  databaseId: string;
  primaryPath: string;
  replicaPath: string;
  lastRefreshedAt: Date | null;
  refreshIntervalSeconds: number;
  isRefreshing: boolean;
  totalRefreshes: number;
  totalErrors: number;
}

export class ReadReplicaService {
  private static instances: Map<string, ReadReplicaService> = new Map();

  private readonly databaseId: string;
  private readonly primaryPath: string;
  private readonly replicaPath: string;
  private readonly refreshInterval: number; // seconds

  private readonlyInstance: DuckDBInstance | null = null;
  private readonlyConn: any = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing: boolean = false;
  private lastRefreshedAt: Date | null = null;

  // Stats
  private totalRefreshes: number = 0;
  private totalErrors: number = 0;

  private constructor(databaseId: string, primaryPath: string) {
    this.databaseId = databaseId;
    this.primaryPath = primaryPath;
    this.replicaPath = primaryPath.replace(/\.db$/, '.ro.db');
    this.refreshInterval = config.readReplica.refreshInterval;
  }

  static getInstance(databaseId: string, primaryPath: string): ReadReplicaService {
    if (!ReadReplicaService.instances.has(databaseId)) {
      ReadReplicaService.instances.set(
        databaseId,
        new ReadReplicaService(databaseId, primaryPath)
      );
    }
    return ReadReplicaService.instances.get(databaseId)!;
  }

  /**
   * Start the read replica service. Performs an initial snapshot,
   * then schedules periodic refreshes.
   */
  async start(): Promise<void> {
    if (!config.readReplica.enabled) {
      logger.info(`Read replica disabled for database ${this.databaseId}`);
      return;
    }

    logger.info(`Starting read replica for database ${this.databaseId}, refresh every ${this.refreshInterval}s`);

    // Initial snapshot
    await this.refreshReplica();

    // Schedule periodic refreshes
    this.refreshTimer = setInterval(
      () => this.refreshReplica().catch(err =>
        logger.error(`Read replica refresh failed for ${this.databaseId}:`, err)
      ),
      this.refreshInterval * 1000
    );
  }

  /**
   * Stop the read replica service.
   */
  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.closeReadonlyConnection();
    this.readonlyInstance = null;

    // Clean up replica file
    try {
      if (fs.existsSync(this.replicaPath)) {
        fs.unlinkSync(this.replicaPath);
      }
      const tmpPath = this.replicaPath + '.tmp';
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (err) {
      logger.warn(`Failed to clean up replica files for ${this.databaseId}:`, err);
    }

    ReadReplicaService.instances.delete(this.databaseId);
    logger.info(`Read replica stopped for database ${this.databaseId}`);
  }

  /**
   * Execute a read-only query against the replica.
   * Falls back to null if replica is not available.
   */
  async executeReadOnly(query: string, params?: any[]): Promise<any[] | null> {
    if (!this.readonlyConn) {
      return null; // Replica not ready — caller should fall back to primary
    }

    try {
      let result: any[];
      let columnNames: string[] = [];

      if (params && params.length > 0) {
        const prepared = await this.readonlyConn.prepare(query);
        // Bind parameters (same logic as DuckDBConnection)
        for (let i = 0; i < params.length; i++) {
          const value = params[i];
          if (value === null || value === undefined) {
            prepared.bindNull(i + 1);
          } else if (typeof value === 'string') {
            prepared.bindVarchar(i + 1, value);
          } else if (typeof value === 'number') {
            if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
              prepared.bindInteger(i + 1, value);
            } else {
              prepared.bindDouble(i + 1, value);
            }
          } else if (typeof value === 'boolean') {
            prepared.bindBoolean(i + 1, value);
          } else {
            prepared.bindVarchar(i + 1, String(value));
          }
        }
        const reader = await prepared.runAndReadAll();
        result = reader.getRows();
        columnNames = reader.columnNames();
      } else {
        const reader = await this.readonlyConn.runAndReadAll(query);
        result = reader.getRows();
        columnNames = reader.columnNames();
      }

      // Convert to objects
      if (result && result.length > 0 && columnNames.length > 0) {
        return result.map(row => {
          const obj: any = {};
          columnNames.forEach((colName, index) => {
            const value = row[index];
            if (value && typeof value === 'object' && value.micros !== undefined) {
              obj[colName] = value.toString();
            } else {
              obj[colName] = value;
            }
          });
          return obj;
        });
      }

      return result || [];
    } catch (error) {
      logger.error(`Read replica query failed for ${this.databaseId}:`, error);
      // Close connection on error to force reconnection on next refresh
      this.closeReadonlyConnection();
      return null; // Caller falls back to primary
    }
  }

  /**
   * Get replica status for monitoring.
   */
  getStatus(): ReplicaStatus {
    return {
      enabled: config.readReplica.enabled,
      databaseId: this.databaseId,
      primaryPath: this.primaryPath,
      replicaPath: this.replicaPath,
      lastRefreshedAt: this.lastRefreshedAt,
      refreshIntervalSeconds: this.refreshInterval,
      isRefreshing: this.isRefreshing,
      totalRefreshes: this.totalRefreshes,
      totalErrors: this.totalErrors,
    };
  }

  /**
   * Check if the replica is available for queries.
   */
  isAvailable(): boolean {
    return config.readReplica.enabled && this.readonlyConn !== null;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Create a point-in-time snapshot of the primary database.
   * Atomic: writes to temp file, then renames.
   */
  private async refreshReplica(): Promise<void> {
    if (this.isRefreshing) {
      logger.debug(`Read replica refresh already in progress for ${this.databaseId}, skipping`);
      return;
    }

    if (!fs.existsSync(this.primaryPath)) {
      logger.warn(`Primary database not found at ${this.primaryPath}, skipping replica refresh`);
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      // Close existing read-only connection before replacing the file
      this.closeReadonlyConnection();
      this.readonlyInstance = null;

      const tmpPath = this.replicaPath + '.tmp';

      // Atomic copy: write to temp file, then rename
      await fs.promises.copyFile(this.primaryPath, tmpPath);
      await fs.promises.rename(tmpPath, this.replicaPath);

      // Open read-only connection to the new snapshot
      this.readonlyInstance = await DuckDBInstance.create(this.replicaPath, {
        access_mode: 'READ_ONLY',
      });
      this.readonlyConn = await this.readonlyInstance.connect();

      this.lastRefreshedAt = new Date();
      this.totalRefreshes++;

      const durationMs = Date.now() - startTime;
      logger.info(`Read replica refreshed for ${this.databaseId} in ${durationMs}ms`);
    } catch (error) {
      this.totalErrors++;
      logger.error(`Read replica refresh failed for ${this.databaseId}:`, error);
    } finally {
      this.isRefreshing = false;
    }
  }

  private closeReadonlyConnection(): void {
    if (this.readonlyConn) {
      try { this.readonlyConn.closeSync(); } catch (err) {
        logger.debug(`Read replica connection close error for ${this.databaseId}:`, err);
      }
      this.readonlyConn = null;
    }
  }
}

export default ReadReplicaService;
