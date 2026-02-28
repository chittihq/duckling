import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
class AlphabeticalSequencer extends BaseSequencer {
    async sort(files) {
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
        reporters: ['verbose'],
        globals: true,
        sequence: {
            sequencer: AlphabeticalSequencer,
        },
    },
});
