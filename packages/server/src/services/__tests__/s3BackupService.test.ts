import { afterEach, describe, expect, test, vi } from 'vitest';
import s3BackupService from '../s3BackupService';
import { S3Config } from '../../database/databaseConfig';

const s3Config: S3Config = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
};

describe('S3BackupService.listBackups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fetches all pages using continuation token', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-2.db', Size: 2 }],
        IsTruncated: true,
        NextContinuationToken: 'next-page',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-1.db', Size: 1 }],
        IsTruncated: false,
      });
    vi.spyOn(s3BackupService as any, 'getClient').mockReturnValue({ send });
    vi.spyOn(s3BackupService as any, 'getPrefix').mockReturnValue('db/');

    const backups = await s3BackupService.listBackups('db', s3Config);

    expect(backups).toHaveLength(2);
    expect(backups.map(backup => backup.key)).toEqual(['db/backup-2.db', 'db/backup-1.db']);
    expect((send.mock.calls[0][0] as any).input.ContinuationToken).toBeUndefined();
    expect((send.mock.calls[1][0] as any).input.ContinuationToken).toBe('next-page');
  });

  test('filters out prefix placeholder and .mac objects across pages', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'db/' },
          { Key: 'db/backup-2.db', Size: 2 },
          { Key: 'db/backup-2.db.mac', Size: 1 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'next-page',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db/backup-1.db', Size: 1 }],
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
