import * as fs from 'fs';
import * as path from 'path';
import config from '../config';

export interface DatabaseConfig {
  id: string;
  name: string;
  mysqlConnectionString: string;
  duckdbPath: string;
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
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const configs: DatabaseConfig[] = JSON.parse(data);
        configs.forEach(config => {
          this.databases.set(config.id, config);
        });
      } else {
        // Create default database from env
        this.createDefaultDatabase();
      }
    } catch (error) {
      console.error('Failed to load database config:', error);
      this.createDefaultDatabase();
    }
  }

  private createDefaultDatabase(): void {
    const defaultDb: DatabaseConfig = {
      id: 'default',
      name: 'Default Database',
      mysqlConnectionString: process.env.MYSQL_CONNECTION_STRING || '',
      duckdbPath: config.duckdb.path, // Use config for correct path in dev and production
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.databases.set('default', defaultDb);
    this.saveConfig();
  }

  private saveConfig(): void {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const configs = Array.from(this.databases.values());
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
    } catch (error) {
      console.error('Failed to save database config:', error);
      throw error;
    }
  }

  getAllDatabases(): DatabaseConfig[] {
    return Array.from(this.databases.values());
  }

  getDatabase(id: string): DatabaseConfig | undefined {
    return this.databases.get(id);
  }

  addDatabase(config: Omit<DatabaseConfig, 'id' | 'createdAt' | 'updatedAt' | 'duckdbPath'>): DatabaseConfig {
    const id = this.generateId(config.name);
    const newConfig: DatabaseConfig = {
      ...config,
      id,
      duckdbPath: `data/${id}.db`,
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
    if (id === 'default') {
      throw new Error('Cannot delete default database');
    }
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
