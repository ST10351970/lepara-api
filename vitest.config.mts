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
    // npm run test:coverage: which lines of src/ the tests run, as a summary in the
    // terminal and a web page in coverage/index.html (CI keeps it as a download).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
