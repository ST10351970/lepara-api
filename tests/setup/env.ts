import 'dotenv/config';

// Runs before every test file, before any app code is imported.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'https://website.test';

// Tests always talk to the test database, never the development one.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://not:configured@127.0.0.1:1/not_configured_test';
