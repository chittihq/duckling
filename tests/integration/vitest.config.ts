import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';

class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: Parameters<BaseSequencer['sort']>[0]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    fileParallelism: false,
    cache: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/suite6-cdc-realtime.test.ts',
      'src/suite10-mysql-protocol-compat.test.ts',
      'src/suite13-interrupted-incremental-restart.test.ts',
      'src/suite14-incremental-crash-probe.test.ts',
    ],
    reporters: ['verbose'],
    globals: true,
    sequence: {
      sequencer: AlphabeticalSequencer,
    },
  },
});
