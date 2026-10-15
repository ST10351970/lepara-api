import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/env.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    // Database tests share one test database, so test files run one at a time.
    fileParallelism: false,
    // Generous limits: the test database is in the cloud, so each query crosses the internet.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
