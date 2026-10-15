import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, type ClientConfig } from 'pg';
import { describeDatabase, explainScriptError, scriptConnectionConfig } from './connection';
import { MIGRATION_NAME_PATTERN, parseMigrationFile } from './migrationFile';

/**
 * A small migration runner.
 *
 *   npm run migrate:up            apply every migration not yet applied
 *   npm run migrate:down          undo the last migration
 *   npm run migrate:down -- 2     undo the last 2
 *   npm run migrate:down -- all   undo everything (development only)
 *   npm run migrate:status        list applied and pending migrations
 *
 * Each migration runs in its own transaction: it either applies completely or
 * not at all. Applied migrations are recorded in the schema_migrations table.
 */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 7_340_112; // any fixed number: stops two runs migrating at the same time

type Log = (line: string) => void;

async function migrationFileNames(): Promise<string[]> {
  const names = await readdir(MIGRATIONS_DIR);
  return names.filter((name) => MIGRATION_NAME_PATTERN.test(name)).sort();
}

async function withLockedClient<T>(
  config: ClientConfig,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name   varchar(255) PRIMARY KEY,
         run_at timestamptz  NOT NULL DEFAULT now()
       )`,
    );
    return await work(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

async function appliedNames(client: Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  return result.rows.map((row) => row.name);
}

async function runInTransaction(client: Client, fileName: string, work: () => Promise<void>) {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Migration ${fileName} failed and was rolled back: ${reason}`, {
      cause: error,
    });
  }
}

export async function migrateUp(
  config: ClientConfig,
  log: Log = () => undefined,
): Promise<string[]> {
  return withLockedClient(config, async (client) => {
    const applied = new Set(await appliedNames(client));
    const ran: string[] = [];
    for (const fileName of await migrationFileNames()) {
      if (applied.has(fileName)) continue;
      const text = await readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8');
      const { up } = parseMigrationFile(text, fileName);
      await runInTransaction(client, fileName, async () => {
        await client.query(up);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [fileName]);
      });
      ran.push(fileName);
      log(`  applied   ${fileName}`);
    }
    return ran;
  });
}

export async function migrateDown(
  config: ClientConfig,
  steps: number,
  log: Log = () => undefined,
): Promise<string[]> {
  return withLockedClient(config, async (client) => {
    const toUndo = (await appliedNames(client)).reverse().slice(0, steps);
    const undone: string[] = [];
    for (const fileName of toUndo) {
      const text = await readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8');
      const { down } = parseMigrationFile(text, fileName);
      await runInTransaction(client, fileName, async () => {
        await client.query(down);
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [fileName]);
      });
      undone.push(fileName);
      log(`  undone    ${fileName}`);
    }
    return undone;
  });
}

export async function migrationStatus(
  config: ClientConfig,
): Promise<{ applied: string[]; pending: string[] }> {
  return withLockedClient(config, async (client) => {
    const applied = await appliedNames(client);
    const pending = (await migrationFileNames()).filter((name) => !applied.includes(name));
    return { applied, pending };
  });
}

async function main(): Promise<void> {
  const [command = 'status', argument] = process.argv.slice(2);
  const config = scriptConnectionConfig();
  console.log(`Database: ${describeDatabase(String(config.connectionString))}`);

  if (command === 'up') {
    const ran = await migrateUp(config, console.log);
    console.log(ran.length ? `Done: ${ran.length} applied.` : 'Already up to date.');
    return;
  }

  if (command === 'down') {
    if (argument === 'all' && process.env.NODE_ENV === 'production') {
      throw new Error('"down all" is blocked when NODE_ENV=production.');
    }
    const steps = argument === 'all' ? Number.POSITIVE_INFINITY : Number(argument ?? 1);
    if (!Number.isInteger(steps) && steps !== Number.POSITIVE_INFINITY) {
      throw new Error('Usage: npm run migrate:down -- <number of migrations | all>');
    }
    if (steps < 1) throw new Error('Give a number of migrations of 1 or more.');
    const undone = await migrateDown(config, steps, console.log);
    console.log(undone.length ? `Done: ${undone.length} undone.` : 'Nothing to undo.');
    return;
  }

  if (command === 'status') {
    const { applied, pending } = await migrationStatus(config);
    applied.forEach((name) => console.log(`  applied   ${name}`));
    pending.forEach((name) => console.log(`  pending   ${name}`));
    if (!applied.length && !pending.length) console.log('  no migration files found');
    return;
  }

  throw new Error(`Unknown command "${command}". Use up, down or status.`);
}

// Run main() only when started from the command line, not when tests import this file.
if (typeof module !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    console.error(`\n${explainScriptError(error, url)}\n`);
    process.exit(1);
  });
}
