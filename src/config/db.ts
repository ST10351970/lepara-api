import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';
import { isRetryableTransactionError } from '../utils/pgErrors';

/**
 * One connection pool for the whole API.
 *
 * SQL injection rule: SQL text is always written in the code, and anything a
 * user sends goes in the `values` array as $1, $2, ... placeholders. Never
 * build SQL by joining strings with user input.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED } : false,
  max: env.DB_POOL_MAX,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: 'lepara-api',
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle database connection failed');
});

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  db: Queryable = pool,
) {
  return db.query<Row>(text, values);
}

/**
 * Runs `work` inside BEGIN ... COMMIT on one connection. Any error rolls the
 * whole thing back, so a half-finished change can never be saved. A
 * transaction conflict or deadlock is retried once.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  { retries = 1 }: { retries?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < retries && isRetryableTransactionError(error)) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Inside a transaction: runs `work` so that if it fails, only its own changes
 * are undone and the transaction can carry on (normally one failed statement
 * spoils the whole transaction). Used to retry an insert with a new
 * reference number after a clash.
 */
export async function withSavepoint<T>(client: Queryable, work: () => Promise<T>): Promise<T> {
  await client.query('SAVEPOINT attempt');
  try {
    const result = await work();
    await client.query('RELEASE SAVEPOINT attempt');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt').catch(() => undefined);
    throw error;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
