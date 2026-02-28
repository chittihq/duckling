import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import s3BackupService from '../s3BackupService';

const createEncryptedPayload = (plaintext: Buffer, keyHex: string) => {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = Buffer.concat([iv, ciphertext]);
  const mac = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return { payload, mac };
};

const s3Config = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  encryption: 'client-aes256' as const,
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
    const targetPath = dir;
    const { payload } = createEncryptedPayload(Buffer.from('safe content'), s3Config.encryptionKey);
    const backupKey = 'db/backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => ({
        Body: Readable.from([command.input.Key === `${backupKey}.mac` ? 'bad-mac' : '']),
      })),
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
  });

  test('decrypts backup only after successful HMAC verification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-s3-test-'));
    tempDirs.push(dir);
    const targetPath = path.join(dir, 'restore.db');
    const plaintext = Buffer.from('verified database contents');
    const { payload, mac } = createEncryptedPayload(plaintext, s3Config.encryptionKey);
    const backupKey = 'db/backup.db';

    const fakeClient = {
      send: vi.fn(async (command: any) => ({
        Body: Readable.from([command.input.Key === `${backupKey}.mac` ? mac : '']),
      })),
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
