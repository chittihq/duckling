import { AppenderSyncStats } from './sequentialAppenderService';

export type GuardedSyncResult =
  | { status: 'completed'; stats: AppenderSyncStats }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };

/**
 * Legacy DuckDB automation service removed during the ClickHouse migration.
 */
class AutomationService {
  static getInstance(): never {
    throw new Error('AutomationService was removed during the ClickHouse migration');
  }

  static getExistingInstance(): undefined {
    return undefined;
  }

  static closeInstance(): void {}

  static async restartS3ScheduleIfRunning(): Promise<void> {}
}

export default AutomationService;
