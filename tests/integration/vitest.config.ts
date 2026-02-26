import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
    globals: true,
  },
});
