import * as fs from 'fs';
import ClickHouseConnection from '../database/clickhouse';

/**
 * Startup storage report.
 *
 * The replica's bulk data lives in ClickHouse's data directory, inside a
 * different container — so "where is my data actually stored?" is not
 * answerable from duckling's own filesystem. Operators who attach a dedicated
 * block volume routinely discover only after it fills that the compose was
 * still writing to the boot disk's Docker volume root.
 *
 * ClickHouse knows its own layout, so we ask it (`system.disks`) and print the
 * path plus free/total space next to duckling's own data directory. Comparing
 * the reported capacity against the attached volume's size tells an operator
 * immediately whether the mount took effect.
 */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function describeLocalPath(dirPath: string): string {
  try {
    // statfs lands on the filesystem backing the path — a bind-mounted volume
    // reports the attached disk's capacity, a Docker-managed one reports the
    // boot disk's.
    const stats = (fs as any).statfsSync?.(dirPath);
    if (!stats) return '';
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return ` — ${formatBytes(free)} free of ${formatBytes(total)}`;
  } catch {
    return '';
  }
}

export async function logStorageReport(dataDir: string): Promise<void> {
  const lines: string[] = [];
  lines.push(`   duckling data:  ${dataDir}${describeLocalPath(dataDir)}`);

  try {
    const clickhouse = ClickHouseConnection.getInstance();
    const disks = await clickhouse.execute(
      'SELECT name, path, free_space, total_space FROM system.disks ORDER BY name'
    );

    if (Array.isArray(disks) && disks.length > 0) {
      for (const disk of disks) {
        const free = Number(disk.free_space);
        const total = Number(disk.total_space);
        lines.push(
          `   ClickHouse "${disk.name}": ${disk.path} — ${formatBytes(free)} free of ${formatBytes(total)}`
        );
      }
    } else {
      lines.push('   ClickHouse: no disks reported');
    }
  } catch (error) {
    // Never block startup on this: ClickHouse may still be coming up, and a
    // missing storage report is not a reason to fail a boot.
    lines.push(
      `   ClickHouse: unavailable (${error instanceof Error ? error.message : 'unknown error'})`
    );
  }

  console.log('\n💾 Storage locations:');
  lines.forEach(line => console.log(line));
  console.log(
    '   (Capacity should match your intended disk. If you attached a dedicated\n' +
    '    volume but see the boot disk\'s size, the mount did not take effect —\n' +
    '    see DUCKLING_STORAGE_ROOT in docs/DEPLOYMENT.md.)\n'
  );
}
