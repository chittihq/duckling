import * as fs from 'fs';
import * as path from 'path';
import config from '../config';

export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;        // custom endpoint for S3-compatible storage (MinIO, R2, B2, etc.)
  forcePathStyle?: boolean; // required by most S3-compatible providers
  pathPrefix?: string;
  // Encryption
  encryption?: 'none' | 'sse-s3' | 'sse-kms' | 'client-aes256';
  kmsKeyId?: string;        // optional KMS key ARN/ID for sse-kms
  encryptionKey?: string;   // 64-char hex (32-byte) key for client-aes256
  // Scheduled S3 backups (independent of local backup schedule)
  s3BackupIntervalHours?: number; // e.g. 6, 12, 24; 0 or absent = piggyback local backup only
  s3BackupRetentionDays?: number; // days to keep S3 backups; 0 or absent = keep indefinitely
}

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
    mirrors?: Array<{
      table: string;
      mirrorName: string;
    }>;
  };
  createdAt: string;
  updatedAt: string;
  s3?: S3Config;
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
        this.databases.set(config.id, {
          ...config,
          clickhouseDatabase: config.clickhouseDatabase || config.id || config.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        });
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
    const defaultDb: DatabaseConfig = {
      id: 'default',
      name: 'Default Database',
      mysqlConnectionString: process.env.MYSQL_CONNECTION_STRING || '',
      clickhouseDatabase: config.clickhouse.database,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.databases.set('default', defaultDb);
    this.saveConfig();
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
    };
    this.databases.set(id, newConfig);
    this.saveConfig();
    return newConfig;
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
