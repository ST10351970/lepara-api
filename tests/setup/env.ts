import 'dotenv/config';

// Runs before every test file, before any app code is imported.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'https://website.test';

// Fixed secrets for tests only. Never use these anywhere else.
process.env.JWT_ADMIN_SECRET = 'test-only-admin-token-secret-not-for-real-use';
process.env.TOTP_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff'.repeat(2);

// Tests never send email, whatever .env says.
process.env.BREVO_API_KEY = '';
process.env.SMTP_HOST = '';

// Tests always talk to the test database, never the development one.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://not:configured@127.0.0.1:1/not_configured_test';
