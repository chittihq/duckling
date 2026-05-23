import * as fs from 'fs';
import * as path from 'path';
import config from '../config';

/**
 * Position in the MySQL binlog captured at the start of a bootstrap dump. PeerDB
 * uses this to resume from right after the consistent snapshot so we don't miss
 * any rows between dump completion and CDC takeover.
 */
export interface BootstrapBinlogPosition {
  mode: 'gtid' | 'filepos';
  // GTID set, e.g. "0d4f...:1-12345" — preferred when MySQL has GTID enabled.
  gtid?: string;
  // Classic file+position fallback when GTID isn't available.
  file?: string;
  position?: number;
  capturedAt: string;
}

export interface BootstrapTableProgress {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  recordsProcessed: number;
  lastProcessedId?: string | number | null;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface BootstrapState {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  binlogPosition?: BootstrapBinlogPosition;
  tableProgress: Record<string, BootstrapTableProgress>;
  error?: string;
}

/**
 * The Phase-2 backend in the three-phase replication strategy. See
 * docs/replication-strategy.md.
 *
 * - `peerdb`  — real binlog CDC via PeerDB (requires the PeerDB stack and a
 *               binlog-capable MySQL source)
 * - `polling` — in-repo CdcCompatibilityService row-count + change-token polling
 * - `none`    — no continuous replication; bootstrap only
 */
export type ReplicationMode = 'peerdb' | 'polling' | 'none';

export interface DatabaseConfig {
  id: string;
  name: string;
  mysqlConnectionString: string;
  clickhouseDatabase: string;
  peerdb?: {
    enabled: boolean;
    sourcePeerName?: string;
    targetPeerName?: string;
    mirrorPrefix?: string;
    mysqlDisableTls?: boolean;
    mysqlFlavor?: 'mysql' | 'mariadb';
    replicationMechanism?: 'auto' | 'gtid' | 'filepos';
    mysqlSetup?: string[];
    mirrors?: Array<{
      table: string;
      mirrorName: string;
    }>;
  };
  bootstrap?: BootstrapState;
  /**
   * When unset, the replication coordinator runs the capability probe each time
   * and picks the best supported mode automatically. Set explicitly to pin.
   */
  replicationMode?: ReplicationMode;
  createdAt: string;
  updatedAt: string;
}

// Use config to ensure correct path in both dev and production
const CONFIG_FILE = path.join(config.paths.data, 'databases.json');

export class DatabaseConfigManager {
  private static instance: DatabaseConfigManager;
  private databases: Map<string, DatabaseConfig> = new Map();

  private constructor() {
    this.loadConfig();
  }

  static getInstance(): DatabaseConfigManager {
    if (!DatabaseConfigManager.instance) {
      DatabaseConfigManager.instance = new DatabaseConfigManager();
    }
    return DatabaseConfigManager.instance;
  }

  private loadConfig(): void {
    if (!fs.existsSync(CONFIG_FILE)) {
      // Create default database from env
      this.createDefaultDatabase();
      return;
    }

    let data: string;
    try {
      data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    } catch (error) {
      // I/O error (EACCES, EIO, EMFILE, etc.) — the file may be perfectly valid.
      // Do NOT rename or overwrite it; just crash so the operator can fix the environment.
      throw new Error(`Cannot read database config at ${CONFIG_FILE}: ${error instanceof Error ? error.message : error}`);
    }

    try {
      const configs: DatabaseConfig[] = JSON.parse(data);
      configs.forEach(config => {
        this.databases.set(config.id, this.applyMigrations({
          ...config,
          clickhouseDatabase: config.clickhouseDatabase || config.id || config.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        }));
      });
    } catch (error) {
      // Parse/validation failure — the file content is genuinely corrupt.
      let backupPath = CONFIG_FILE;
      try {
        backupPath = this.backupCorruptedConfig();
        console.error(`Failed to load database config from ${CONFIG_FILE}. Corrupted file moved to ${backupPath}.`, error);
      } catch (backupError) {
        console.error(`Failed to load database config from ${CONFIG_FILE} and backup also failed:`, backupError);
      }
      throw new Error(
        `Database config is corrupted (backup attempted at ${backupPath}). Please repair or restore the config file before continuing.`
      );
    }
  }

  private createDefaultDatabase(): void {
    // The env-driven default database stays on polling mode — it's the one
    // the legacy /sync/full path expects to operate on, and the polling
    // schema is what all the existing integration tests assume. Operators
    // who want PeerDB CDC create explicit databases via POST /api/databases
    // with `replicationMode: 'peerdb'`.
    const defaultDb: DatabaseConfig = {
      id: 'default',
      name: 'Default Database',
      mysqlConnectionString: process.env.MYSQL_CONNECTION_STRING || '',
      clickhouseDatabase: config.clickhouse.database,
      replicationMode: 'polling',
      bootstrap: {
        status: 'completed',
        completedAt: new Date().toISOString(),
        tableProgress: {},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.databases.set('default', this.applyMigrations(defaultDb));
    this.saveConfig();
  }

  /**
   * Backfill fields added to DatabaseConfig over time onto records loaded from
   * older databases.json files. Pre-existing databases pre-date the three-phase
   * strategy: their data was loaded into the `<table>__raw` + projection-view
   * layout, which only the polling backend understands. We pin `replicationMode`
   * to `'polling'` for them so the coordinator doesn't suddenly try to attach
   * PeerDB to that schema (PeerDB rejects views as destinations).
   *
   * An operator who wants to migrate an existing database to PeerDB can:
   *   POST /api/databases/:id/replication-mode { mode: 'peerdb' }
   *   POST /api/databases/:id/bootstrap        { force: true }
   * — which re-dumps the data into the PeerDB-compatible schema.
   */
  private applyMigrations(dbConfig: DatabaseConfig): DatabaseConfig {
    if (!dbConfig.bootstrap) {
      dbConfig.bootstrap = {
        status: 'completed',
        completedAt: dbConfig.createdAt,
        tableProgress: {},
      };
      // Existing DBs were laid out for the polling backend; pin so the
      // coordinator doesn't auto-promote them to peerdb on next /cdc/start.
      if (!dbConfig.replicationMode) {
        dbConfig.replicationMode = 'polling';
      }
    } else if (!dbConfig.bootstrap.tableProgress) {
      dbConfig.bootstrap.tableProgress = {};
    }
    return dbConfig;
  }

  private saveConfig(): void {
    const tempFile = `${CONFIG_FILE}.tmp`;
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const configs = Array.from(this.databases.values());
      fs.writeFileSync(tempFile, JSON.stringify(configs, null, 2));
      fs.renameSync(tempFile, CONFIG_FILE);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch {}
      console.error('Failed to save database config:', error);
      throw error;
    }
  }

  private backupCorruptedConfig(): string {
    const backupPath = `${CONFIG_FILE}.corrupted.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(CONFIG_FILE, backupPath);
    return backupPath;
  }

  getAllDatabases(): DatabaseConfig[] {
    return Array.from(this.databases.values());
  }

  getDatabase(id: string): DatabaseConfig | undefined {
    return this.databases.get(id);
  }

  addDatabase(
    config: Omit<DatabaseConfig, 'id' | 'createdAt' | 'updatedAt' | 'clickhouseDatabase'> & {
      clickhouseDatabase?: string;
    }
  ): DatabaseConfig {
    const id = this.generateId(config.name);
    const newConfig: DatabaseConfig = {
      ...config,
      id,
      clickhouseDatabase: config.clickhouseDatabase || id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // New databases haven't been bootstrapped yet — operator (or auto-bootstrap)
      // calls POST /api/databases/:id/bootstrap to run Phase 1.
      bootstrap: config.bootstrap ?? {
        status: 'pending',
        tableProgress: {},
      },
    };
    this.databases.set(id, newConfig);
    this.saveConfig();
    return newConfig;
  }

  /**
   * Apply a mutation atomically to the in-memory config and persist. Used by
   * the bootstrap and replication-coordinator services to advance state without
   * stepping on each other or on operator updates.
   */
  patchDatabase(id: string, mutator: (current: DatabaseConfig) => DatabaseConfig): DatabaseConfig | null {
    const existing = this.databases.get(id);
    if (!existing) return null;
    const patched = mutator({ ...existing });
    patched.id = existing.id;
    patched.createdAt = existing.createdAt;
    patched.updatedAt = new Date().toISOString();
    this.databases.set(id, patched);
    this.saveConfig();
    return patched;
  }

  updateDatabase(id: string, updates: Partial<Omit<DatabaseConfig, 'id' | 'createdAt'>>): DatabaseConfig | null {
    const existing = this.databases.get(id);
    if (!existing) return null;

    const updated: DatabaseConfig = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.databases.set(id, updated);
    this.saveConfig();
    return updated;
  }

  deleteDatabase(id: string): boolean {
    const deleted = this.databases.delete(id);
    if (deleted) {
      this.saveConfig();
    }
    return deleted;
  }

  private generateId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    let id = base;
    let counter = 1;
    while (this.databases.has(id)) {
      id = `${base}_${counter}`;
      counter++;
    }
    return id;
  }
}
