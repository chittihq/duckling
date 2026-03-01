import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import s3BackupService from '../s3BackupService';
import type { S3Config } from '../../database/databaseConfig';

const createEncryptedPayload = (plaintext: Buffer, keyHex: string) => {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = Buffer.concat([iv, ciphertext]);
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(iv);
  hmac.update(ciphertext);
  const mac = hmac.digest('hex');
  return { payload, mac };
};

const s3Config: S3Config = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  encryption: 'client-aes256',
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
};

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('s3BackupService downloadAndDecrypt', () => {
  test('verifies HMAC before decryption and rejects tampered ciphertext', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const { payload } = createEncryptedPayload(Buffer.from('safe content'), s3Config.encryptionKey!);
    const backupKey = 'db/backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => {
        if (command.input.Key !== `${backupKey}.mac`) {
          throw new Error(`Unexpected key: ${command.input.Key}`);
        }
        return { Body: Readable.from(['bad-mac']) };
      }),
    };

    await expect(
      (s3BackupService as any).downloadAndDecrypt(
        fakeClient,
        Readable.from([payload]),
        backupKey,
        targetPath,
        s3Config
      )
    ).rejects.toThrow('HMAC verification failed');
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.tmp`)).toBe(false);
  });

  test('rejects restore when .mac companion is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const { payload } = createEncryptedPayload(Buffer.from('safe content'), s3Config.encryptionKey!);
    const backupKey = 'db/backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => {
        if (command.input.Key !== `${backupKey}.mac`) {
          throw new Error(`Unexpected key: ${command.input.Key}`);
        }
        const err: any = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }),
    };

    await expect(
      (s3BackupService as any).downloadAndDecrypt(
        fakeClient,
        Readable.from([payload]),
        backupKey,
        targetPath,
        s3Config
      )
    ).rejects.toThrow('Missing HMAC companion');
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.tmp`)).toBe(false);
  });

  test('decrypts backup only after successful HMAC verification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const plaintext = Buffer.from('verified database contents');
    const { payload, mac } = createEncryptedPayload(plaintext, s3Config.encryptionKey!);
    const backupKey = 'db/backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => {
        if (command.input.Key !== `${backupKey}.mac`) {
          throw new Error(`Unexpected key: ${command.input.Key}`);
        }
        return { Body: Readable.from([mac]) };
      }),
    };

    await (s3BackupService as any).downloadAndDecrypt(
      fakeClient,
      Readable.from([payload]),
      backupKey,
      targetPath,
      s3Config
    );

    expect(fs.readFileSync(targetPath)).toEqual(plaintext);
  });
});

describe('s3BackupService downloadBackup (public API)', () => {
  test('downloads encrypted backup and restores plaintext when .mac matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const plaintext = Buffer.from('public-api restore content');
    const { payload, mac } = createEncryptedPayload(plaintext, s3Config.encryptionKey!);
    const backupKey = 'db/public-backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => {
        if (command.input.Key === backupKey) {
          return { Body: Readable.from([payload]) };
        }
        if (command.input.Key === `${backupKey}.mac`) {
          return { Body: Readable.from([mac]) };
        }
        throw new Error(`Unexpected key: ${command.input.Key}`);
      }),
    };

    vi.spyOn(s3BackupService as any, 'getClient').mockReturnValue(fakeClient);

    await s3BackupService.downloadBackup(backupKey, targetPath, s3Config);

    expect(fs.readFileSync(targetPath)).toEqual(plaintext);
    expect(fakeClient.send).toHaveBeenCalledTimes(2);
  });

  test('rejects public restore when .mac companion is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const { payload } = createEncryptedPayload(Buffer.from('missing-mac-content'), s3Config.encryptionKey!);
    const backupKey = 'db/public-backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => {
        if (command.input.Key === backupKey) {
          return { Body: Readable.from([payload]) };
        }
        if (command.input.Key === `${backupKey}.mac`) {
          const err: any = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        throw new Error(`Unexpected key: ${command.input.Key}`);
      }),
    };

    vi.spyOn(s3BackupService as any, 'getClient').mockReturnValue(fakeClient);

    await expect(
      s3BackupService.downloadBackup(backupKey, targetPath, s3Config)
    ).rejects.toThrow('Missing HMAC companion');

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.tmp`)).toBe(false);
    expect(fs.existsSync(`${targetPath}.enc`)).toBe(false);
  });
});

describe('S3BackupService.listBackups', () => {
  test('fetches all pages using continuation token', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-2.db', Size: 2, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: 'next-page',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-1.db', Size: 1, LastModified: new Date() }],
        IsTruncated: false,
      });
    vi.spyOn(s3BackupService as any, 'getClient').mockReturnValue({ send });
    vi.spyOn(s3BackupService as any, 'getPrefix').mockReturnValue('db/');

    const backups = await s3BackupService.listBackups('db', s3Config);

    expect(backups).toHaveLength(2);
    expect(backups.map(backup => backup.key)).toEqual(['db/backup-2.db', 'db/backup-1.db']);
    const firstCommand = send.mock.calls[0][0] as ListObjectsV2Command;
    const secondCommand = send.mock.calls[1][0] as ListObjectsV2Command;
    expect(firstCommand.input.ContinuationToken).toBeUndefined();
    expect(secondCommand.input.ContinuationToken).toBe('next-page');
  });

  test('filters out prefix placeholder and .mac objects across pages', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'db/', LastModified: new Date() },
          { Key: 'db/backup-2.db', Size: 2, LastModified: new Date() },
          { Key: 'db/backup-2.db.mac', Size: 1, LastModified: new Date() },
        ],
        IsTruncated: true,
        NextContinuationToken: 'next-page',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-1.db', Size: 1, LastModified: new Date() }],
        IsTruncated: false,
      });
    vi.spyOn(s3BackupService as any, 'getClient').mockReturnValue({ send });
    vi.spyOn(s3BackupService as any, 'getPrefix').mockReturnValue('db/');

    const backups = await s3BackupService.listBackups('db', s3Config);

    expect(backups).toEqual([
      expect.objectContaining({ key: 'db/backup-2.db', size: 2 }),
      expect.objectContaining({ key: 'db/backup-1.db', size: 1 }),
    ]);
  });
});
