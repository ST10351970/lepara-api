/** Database tests run only when a separate test database is configured. */
export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

/** Tests empty their database, so refuse anything not clearly meant for testing. */
export function assertTestDatabase(connectionString: string): void {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL points at the database "${name}". Tests wipe their database, ` +
        'so its name must end in _test (for example lepara_test).',
    );
  }
}
