import 'dotenv/config';
import { scriptConnectionConfig } from '../../db/connection';
import { migrateDown, migrateUp } from '../../db/migrate';
import { assertTestDatabase } from './testDatabase';

/**
 * Runs once before all tests: rebuilds the test database from the migration
 * files. Undoing every migration first also proves each down section works.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn('\n  TEST_DATABASE_URL is not set, so database tests are skipped.\n');
    return;
  }
  assertTestDatabase(url);
  const config = scriptConnectionConfig(url);
  await migrateDown(config, Number.POSITIVE_INFINITY);
  await migrateUp(config);
}
