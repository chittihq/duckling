import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import ClickHouseConnection from '../database/clickhouse';
import {
  DatabaseConfig,
  DatabaseConfigManager,
  S3BackupConfig,
} from '../database/databaseConfig';
import logger from '../logger';

export type BackupEntry = {
  /** S3 key of the backup directory marker (suffix `/`). */
  key: string;
  /** Human-readable backup name (`prefix/<name>/`). */
  name: string;
  /** Size in bytes (sum of all objects under the prefix). */
  sizeBytes: number;
  /** Most recent object's LastModified inside the backup directory. */
  lastModified: string;
};

export type RunBackupResult = {
  key: string;
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  message?: string;
};

export type RestoreBackupResult = {
  key: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

/**
 * Per-database service that issues ClickHouse-native `BACKUP DATABASE ... TO S3(...)`
 * and `RESTORE DATABASE ... FROM S3(...)`. Object listing + pruning + delete
 * use the AWS SDK directly.
 *
 * Backups are stored as a directory under `<bucket>/<pathPrefix><name>/` where
 * `name` is `backup-<ISO-timestamp>`. ClickHouse writes its `.backup` metadata
 * file plus the data shards into that directory; we never look inside.
 */
class S3BackupService {
  private static instances: Map<string, S3BackupService> = new Map();

  private readonly databaseId: string;
  private readonly clickhouse: ClickHouseConnection;
  private inFlight = false;

  private constructor(databaseId: string, clickhouse: ClickHouseConnection) {
    this.databaseId = databaseId;
    this.clickhouse = clickhouse;
  }

  static getInstance(databaseId: string, clickhouse: ClickHouseConnection): S3BackupService {
    if (!S3BackupService.instances.has(databaseId)) {
      S3BackupService.instances.set(databaseId, new S3BackupService(databaseId, clickhouse));
    }
    return S3BackupService.instances.get(databaseId)!;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Quick credential + bucket-reachability check. Returns true if the
   * configured credentials can `HeadBucket`. Used by the API for an explicit
   * "test connection" before saving config.
   */
  async testConnection(config: S3BackupConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.s3ClientFromConfig(config);
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Issue `BACKUP DATABASE <ch_db> TO S3(...)`. ClickHouse writes a backup
   * directory at `<bucket>/<pathPrefix>backup-<timestamp>/`. Returns the
   * key + duration; throws on backup failure.
   */
  async runBackup(): Promise<RunBackupResult> {
    if (this.inFlight) {
      throw new Error(`Backup already in progress for database '${this.databaseId}'`);
    }
    const dbConfig = this.requireConfig();
    const s3 = dbConfig.s3Backup!;
    const databaseName = dbConfig.clickhouseDatabase || dbConfig.id;
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const prefix = this.normalizePrefix(s3.pathPrefix, dbConfig.id);
    const key = `${prefix}${name}/`;
    const s3Url = this.buildS3Url(s3, `${prefix}${name}`);

    const startedAt = Date.now();
    this.inFlight = true;
    try {
      logger.info(`[s3-backup] starting BACKUP for ${this.databaseId} → ${s3Url}`);
      const sql = this.buildBackupSql(databaseName, s3Url, s3);
      await this.clickhouse.run(sql);
      const completedAt = Date.now();
      logger.info(`[s3-backup] completed BACKUP for ${this.databaseId} in ${completedAt - startedAt}ms`);
      return {
        key,
        name,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Restore from a backup directory. By default restores into the same
   * database that was backed up; that errors if the target already exists.
   * Pass `asDatabase` to restore under a different name (uses
   * `RESTORE DATABASE x AS y FROM ...`) — required when the original DB
   * still exists, and how the integration tests exercise round-trip without
   * disturbing live state.
   */
  async restoreBackup(
    key: string,
    options: { asDatabase?: string } = {},
  ): Promise<RestoreBackupResult> {
    const dbConfig = this.requireConfig();
    const s3 = dbConfig.s3Backup!;
    const databaseName = dbConfig.clickhouseDatabase || dbConfig.id;
    this.assertKeyWithinPrefix(key, s3.pathPrefix, dbConfig.id);
    const trimmedKey = key.replace(/\/+$/, '');
    const s3Url = this.buildS3Url(s3, trimmedKey);

    const startedAt = Date.now();
    logger.info(`[s3-backup] starting RESTORE for ${this.databaseId} ← ${s3Url}`, {
      asDatabase: options.asDatabase,
    });
    const sql = this.buildRestoreSql(databaseName, s3Url, s3, options.asDatabase);
    await this.clickhouse.run(sql);
    const completedAt = Date.now();
    logger.info(`[s3-backup] completed RESTORE for ${this.databaseId} in ${completedAt - startedAt}ms`);
    return {
      key,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
    };
  }

  /**
   * List all backups under the configured prefix. Groups S3 keys by their
   * first-level "directory" (the backup name) and sums sizes / takes the
   * latest LastModified per group.
   */
  async listBackups(): Promise<BackupEntry[]> {
    const dbConfig = this.requireConfig();
    const s3 = dbConfig.s3Backup!;
    const prefix = this.normalizePrefix(s3.pathPrefix, dbConfig.id);
    const client = this.s3ClientFromConfig(s3);

    const grouped = new Map<string, { sizeBytes: number; lastModified: Date }>();
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue;
        const tail = obj.Key.slice(prefix.length);
        const slashIdx = tail.indexOf('/');
        if (slashIdx === -1) continue; // skip objects sitting directly under prefix
        const name = tail.slice(0, slashIdx);
        const existing = grouped.get(name) ?? { sizeBytes: 0, lastModified: new Date(0) };
        existing.sizeBytes += obj.Size ?? 0;
        const modified = obj.LastModified ?? new Date(0);
        if (modified > existing.lastModified) existing.lastModified = modified;
        grouped.set(name, existing);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return Array.from(grouped.entries())
      .map(([name, info]) => ({
        key: `${prefix}${name}/`,
        name,
        sizeBytes: info.sizeBytes,
        lastModified: info.lastModified.toISOString(),
      }))
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }

  /**
   * Delete a single backup by its directory key. Removes every object under
   * `key` (including the `.backup` manifest).
   */
  async deleteBackup(key: string): Promise<{ deletedObjects: number }> {
    const dbConfig = this.requireConfig();
    const s3 = dbConfig.s3Backup!;
    this.assertKeyWithinPrefix(key, s3.pathPrefix, dbConfig.id);
    const client = this.s3ClientFromConfig(s3);
    const prefix = key.endsWith('/') ? key : `${key}/`;

    let deletedObjects = 0;
    let continuationToken: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({
          Bucket: s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (list.Contents ?? []).map((obj) => ({ Key: obj.Key! })).filter((o) => Boolean(o.Key));
      if (objects.length > 0) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: s3.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        deletedObjects += objects.length - (result.Errors?.length ?? 0);
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    return { deletedObjects };
  }

  /**
   * Prune backups older than `retentionDays`. Returns the keys that were
   * deleted. No-op when `retentionDays` is 0/unset.
   */
  async pruneOldBackups(): Promise<{ deletedBackups: string[] }> {
    const dbConfig = this.requireConfig();
    const s3 = dbConfig.s3Backup!;
    const retentionDays = s3.retentionDays ?? 0;
    if (retentionDays <= 0) return { deletedBackups: [] };

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const all = await this.listBackups();
    const toDelete = all.filter((b) => new Date(b.lastModified).getTime() < cutoff);
    const deletedBackups: string[] = [];
    for (const b of toDelete) {
      try {
        await this.deleteBackup(b.key);
        deletedBackups.push(b.key);
      } catch (error) {
        logger.warn(`[s3-backup] prune: failed to delete ${b.key}`, { error });
      }
    }
    return { deletedBackups };
  }

  private requireConfig(): DatabaseConfig {
    const dbConfig = DatabaseConfigManager.getInstance().getDatabase(this.databaseId);
    if (!dbConfig) throw new Error(`Unknown database '${this.databaseId}'`);
    if (!dbConfig.s3Backup) {
      throw new Error(`Database '${this.databaseId}' has no s3Backup configuration`);
    }
    const s3 = dbConfig.s3Backup;
    if (!s3.bucket || !s3.region || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error(`s3Backup config for '${this.databaseId}' is incomplete (need bucket, region, accessKeyId, secretAccessKey)`);
    }
    return dbConfig;
  }

  private s3ClientFromConfig(s3: S3BackupConfig): S3Client {
    return new S3Client({
      region: s3.region,
      endpoint: s3.endpoint || undefined,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      // S3-compatible providers (MinIO/RustFS/etc.) usually need path-style.
      forcePathStyle: Boolean(s3.endpoint),
    });
  }

  private normalizePrefix(prefix: string | undefined, dbId: string): string {
    let p = (prefix && prefix.trim()) || `${dbId}/`;
    if (!p.endsWith('/')) p = `${p}/`;
    if (p.startsWith('/')) p = p.slice(1);
    return p;
  }

  /**
   * Reject caller-supplied keys that fall outside this database's prefix. The
   * restore/delete routes accept arbitrary S3 keys, so without this guard a
   * caller with API access for database A could erase backups (or restore
   * over data) for database B — or any other prefix in the same bucket.
   */
  private assertKeyWithinPrefix(key: string, configuredPrefix: string | undefined, dbId: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Backup key is required');
    }
    const normalized = key.replace(/^\/+/, '');
    const prefix = this.normalizePrefix(configuredPrefix, dbId);
    if (!normalized.startsWith(prefix)) {
      throw new Error(
        `Backup key '${key}' is outside the configured prefix '${prefix}' for database '${dbId}'`,
      );
    }
  }

  /**
   * Build the S3 URL that ClickHouse's `S3(...)` table function understands.
   * AWS S3 default endpoint follows `https://s3.<region>.amazonaws.com/<bucket>/<key>`;
   * S3-compatible providers use the explicit `endpoint` (with the bucket as the
   * first path segment, path-style).
   */
  private buildS3Url(s3: S3BackupConfig, keyPath: string): string {
    const cleanKey = keyPath.replace(/^\/+/, '');
    if (s3.endpoint && s3.endpoint.trim()) {
      const ep = s3.endpoint.replace(/\/+$/, '');
      return `${ep}/${s3.bucket}/${cleanKey}`;
    }
    return `https://s3.${s3.region}.amazonaws.com/${s3.bucket}/${cleanKey}`;
  }

  /**
   * Build the `BACKUP DATABASE ... TO S3(...)` SQL. ClickHouse expects three
   * positional args: URL, access key, secret key. We single-quote and escape
   * with the standard backslash convention. Database name + URL are already
   * known to be safe (database id + ISO-timestamp + operator-provided prefix
   * are restricted; we still defensively escape to be safe).
   */
  private buildBackupSql(database: string, s3Url: string, s3: S3BackupConfig): string {
    return `BACKUP DATABASE ${this.q(database)} TO S3('${this.escape(s3Url)}', '${this.escape(s3.accessKeyId)}', '${this.escape(s3.secretAccessKey)}')`;
  }

  private buildRestoreSql(
    database: string,
    s3Url: string,
    s3: S3BackupConfig,
    asDatabase?: string,
  ): string {
    // RESTORE errors if the target database already exists; the caller can
    // pass `asDatabase` to land into a different name via the `AS` clause.
    const target = asDatabase && asDatabase !== database
      ? `${this.q(database)} AS ${this.q(asDatabase)}`
      : this.q(database);
    return `RESTORE DATABASE ${target} FROM S3('${this.escape(s3Url)}', '${this.escape(s3.accessKeyId)}', '${this.escape(s3.secretAccessKey)}')`;
  }

  private q(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  private escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }
}

export default S3BackupService;
