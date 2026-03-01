import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform, PassThrough } from 'stream';
import { S3Config } from '../database/databaseConfig';
import logger from '../logger';

// On-disk format for client-side encrypted backups:
//   [16 bytes IV (AES-CTR)][AES-256-CTR ciphertext]
// A companion S3 object at <key>.mac stores HMAC-SHA256(key || IV || ciphertext)
// for integrity verification on restore.
//
// Upload path:  stream file → cipher → S3 multipart (no temp file, works for 500 GB+)
// Restore path: download encrypted blob to temp file → verify HMAC → stream-decrypt
//               (requires one extra copy of the file on disk during restore)

class S3BackupService {
  private getClient(s3Config: S3Config): S3Client {
    return new S3Client({
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      ...(s3Config.endpoint ? { endpoint: s3Config.endpoint } : {}),
      ...(s3Config.forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  private getPrefix(databaseId: string, s3Config: S3Config): string {
    return s3Config.pathPrefix ?? `${databaseId}/`;
  }

  private parseEncryptionKey(hexKey: string): Buffer {
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) {
      throw new Error('encryptionKey must be a 64-character hex string (32 bytes / 256 bits)');
    }
    return key;
  }

  async testConnection(s3Config: S3Config): Promise<void> {
    const client = this.getClient(s3Config);
    await client.send(new HeadBucketCommand({ Bucket: s3Config.bucket }));
  }

  async listBackups(
    databaseId: string,
    s3Config: S3Config
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const client = this.getClient(s3Config);
    const prefix = this.getPrefix(databaseId, s3Config);

    const response = await client.send(
      new ListObjectsV2Command({ Bucket: s3Config.bucket, Prefix: prefix })
    );

    return (response.Contents ?? [])
      .filter(obj => obj.Key && obj.Key !== prefix && !obj.Key.endsWith('.mac'))
      .map(obj => ({
        key: obj.Key!,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(),
      }));
  }

  async uploadBackup(
    databaseId: string,
    duckdbFilePath: string,
    s3Config: S3Config
  ): Promise<string> {
    const client = this.getClient(s3Config);
    const prefix = this.getPrefix(databaseId, s3Config);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${prefix}backup-${timestamp}.db`;

    if (s3Config.encryption === 'client-aes256') {
      await this.uploadEncrypted(client, duckdbFilePath, s3Config, key);
    } else {
      await this.uploadPlain(client, duckdbFilePath, s3Config, key);
    }

    logger.info(`S3 backup uploaded: ${key}`);
    return key;
  }

  private async uploadPlain(
    client: S3Client,
    filePath: string,
    s3Config: S3Config,
    key: string
  ): Promise<void> {
    const params: any = {
      Bucket: s3Config.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
    };

    if (s3Config.encryption === 'sse-s3') {
      params.ServerSideEncryption = 'AES256';
    } else if (s3Config.encryption === 'sse-kms') {
      params.ServerSideEncryption = 'aws:kms';
      if (s3Config.kmsKeyId) params.SSEKMSKeyId = s3Config.kmsKeyId;
    }

    await new Upload({ client, params, queueSize: 4, partSize: 100 * 1024 * 1024 }).done();
  }

  // True streaming client-side encryption — no temp file.
  // The IV is prepended to the ciphertext in the upload stream.
  // HMAC is accumulated during streaming and written as a companion .mac object after upload.
  private async uploadEncrypted(
    client: S3Client,
    filePath: string,
    s3Config: S3Config,
    key: string
  ): Promise<void> {
    const encKey = this.parseEncryptionKey(s3Config.encryptionKey!);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', encKey, iv);
    const hmac = crypto.createHmac('sha256', encKey);
    hmac.update(iv);

    // Accumulate HMAC over ciphertext while it flows through
    const hmacAccumulator = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hmac.update(chunk);
        cb(null, chunk);
      },
    });

    // PassThrough is the body given to the multipart Upload
    const body = new PassThrough();
    const upload = new Upload({
      client,
      params: { Bucket: s3Config.bucket, Key: key, Body: body },
      queueSize: 4,
      partSize: 100 * 1024 * 1024,
    });

    // Prepend IV, then stream: file → cipher → hmacAccumulator → body (→ S3)
    body.write(iv);
    await pipeline(fs.createReadStream(filePath), cipher, hmacAccumulator, body);
    await upload.done();

    // Store HMAC as a companion integrity object
    const hmacValue = hmac.digest('hex');
    await client.send(new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: `${key}.mac`,
      Body: hmacValue,
      ContentType: 'text/plain',
    }));
    logger.info(`HMAC stored: ${key}.mac`);
  }

  async downloadBackup(
    backupKey: string,
    targetPath: string,
    s3Config: S3Config
  ): Promise<void> {
    const client = this.getClient(s3Config);
    const response = await client.send(
      new GetObjectCommand({ Bucket: s3Config.bucket, Key: backupKey })
    );
    if (!response.Body) throw new Error('Empty response body from S3');

    if (s3Config.encryption === 'client-aes256') {
      await this.downloadAndDecrypt(client, response.Body as Readable, backupKey, targetPath, s3Config);
    } else {
      await pipeline(response.Body as Readable, fs.createWriteStream(targetPath));
    }

    logger.info(`S3 backup downloaded: ${backupKey} -> ${targetPath}`);
  }

  // Downloads encrypted blob to a temp file, verifies HMAC, then stream-decrypts to targetPath.
  // Extra disk space required: one encrypted copy of the backup (same size as the source).
  private async downloadAndDecrypt(
    client: S3Client,
    body: Readable,
    backupKey: string,
    targetPath: string,
    s3Config: S3Config
  ): Promise<void> {
    const encKey = this.parseEncryptionKey(s3Config.encryptionKey!);
    const encTempPath = `${targetPath}.enc`;
    const restoreTempPath = `${targetPath}.tmp`;

    try {
      // Step 1: download encrypted blob to temp file
      await pipeline(body, fs.createWriteStream(encTempPath));

      // Step 2: read IV from first 16 bytes
      const iv = Buffer.alloc(16);
      const fd = await fs.promises.open(encTempPath, 'r');
      try {
        await fd.read(iv, 0, 16, 0);
      } finally {
        await fd.close();
      }

      // Step 3: fetch .mac companion (required for client-side encrypted restores)
      let expectedHmac = '';
      try {
        const macResponse = await client.send(
          new GetObjectCommand({ Bucket: s3Config.bucket, Key: `${backupKey}.mac` })
        );
        const chunks: Buffer[] = [];
        for await (const chunk of macResponse.Body as Readable) chunks.push(Buffer.from(chunk));
        expectedHmac = Buffer.concat(chunks).toString('utf8').trim();
      } catch (macErr: any) {
        if (macErr.name === 'NoSuchKey') {
          throw new Error(`Missing HMAC companion for ${backupKey} (.mac object not found)`);
        } else {
          throw macErr;
        }
      }

      // Step 4: single pass over encrypted data to decrypt + compute HMAC
      const hmac = crypto.createHmac('sha256', encKey);
      hmac.update(iv);
      let hmacResult: string | null = null;
      const hmacAccumulator = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          try {
            hmac.update(chunk);
            cb(null, chunk);
          } catch (error) {
            cb(new Error(`Failed to update HMAC during restore: ${(error as Error).message}`));
          }
        },
        flush(cb) {
          try {
            hmacResult = hmac.digest('hex');
            cb();
          } catch (error) {
            cb(new Error(`Failed to finalize HMAC during restore: ${(error as Error).message}`));
          }
        },
      });
      const decipher = crypto.createDecipheriv('aes-256-ctr', encKey, iv);
      await pipeline(
        fs.createReadStream(encTempPath, { start: 16 }),
        hmacAccumulator,
        decipher,
        fs.createWriteStream(restoreTempPath)
      );

      // Step 5: verify HMAC before promoting decrypted file to final target
      if (!hmacResult) {
        throw new Error('HMAC verification failed: could not compute digest during restore');
      }
      if (hmacResult !== expectedHmac) {
        throw new Error('HMAC verification failed: backup is corrupted or has been tampered with');
      }
      logger.info('HMAC verified: backup integrity confirmed');
      await fs.promises.rename(restoreTempPath, targetPath);
    } finally {
      if (fs.existsSync(encTempPath)) {
        try { fs.unlinkSync(encTempPath); } catch (cleanupErr) {
          logger.warn(`Failed to delete temporary encrypted file: ${encTempPath}`, cleanupErr);
        }
      }
      if (fs.existsSync(restoreTempPath)) {
        // Best-effort cleanup for failures before rename (e.g. stream/write errors).
        try { fs.unlinkSync(restoreTempPath); } catch (cleanupErr) {
          logger.warn(`Failed to delete temporary restore file: ${restoreTempPath}`, cleanupErr);
        }
      }
    }
  }

  async deleteBackup(backupKey: string, s3Config: S3Config): Promise<void> {
    const client = this.getClient(s3Config);
    await client.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: backupKey }));
    // Remove companion HMAC object if present (best-effort)
    try {
      await client.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: `${backupKey}.mac` }));
    } catch {}
    logger.info(`S3 backup deleted: ${backupKey}`);
  }
}

export default new S3BackupService();
