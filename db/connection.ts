import 'dotenv/config';
import type { ClientConfig } from 'pg';

/**
 * Connection settings for scripts (migrations, seeds), read straight from the
 * environment. Scripts use the owner account: MIGRATION_DATABASE_URL, or
 * DATABASE_URL if that is not set.
 */
export function scriptConnectionConfig(databaseUrl?: string): ClientConfig {
  const connectionString =
    databaseUrl || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) in your .env file first.');
  }

  const useSsl = process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production';
  return {
    connectionString,
    ssl: useSsl
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
    application_name: 'lepara-scripts',
  };
}

/** Hides the password when a connection string is printed. */
export function describeDatabase(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'the configured database';
  }
}

type ErrorDetails = { message: string; code?: string };

/**
 * Node reports some connection failures as an AggregateError with an EMPTY
 * message (on Windows, "localhost" is tried on both IPv6 and IPv4). This digs
 * out the real message so a script never fails silently.
 */
function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const inner = error.errors.map((e) => errorDetails(e));
    const code = (error as { code?: string }).code ?? inner.find((d) => d.code)?.code;
    return { message: inner.map((d) => d.message).join('; '), code };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      message: error.message || error.name || 'Unknown error',
      code: typeof code === 'string' ? code : undefined,
    };
  }
  return { message: String(error) };
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'EAFNOSUPPORT',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/** A message for the terminal: what went wrong, plus a hint on how to fix it. */
export function explainScriptError(error: unknown, connectionString?: string): string {
  const { message, code } = errorDetails(error);
  const where = connectionString ? describeDatabase(connectionString) : 'the database';
  const hints: string[] = [];

  if ((code && NETWORK_CODES.has(code)) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(message)) {
    hints.push(`Could not reach ${where}.`);
    if (where.startsWith('localhost')) {
      hints.push(
        'The connection string still points at your own computer. Put your cloud connection',
        'string in MIGRATION_DATABASE_URL in .env, and make sure the file is saved.',
      );
    } else {
      hints.push('Check the host name in .env and your internet connection.');
    }
  } else if (code === '28P01') {
    hints.push('The username or password in the connection string is wrong.');
  } else if (code === '3D000') {
    hints.push(`The database in the connection string does not exist on that server.`);
  } else if (/certificate|self[- ]signed|SSL|TLS/i.test(message)) {
    hints.push('There is an SSL problem. Check DATABASE_SSL in .env and remove any ?sslmode=');
    hints.push('from the end of the connection string.');
  }

  const detail = `${message}${code && !message.includes(code) ? ` (${code})` : ''}`;
  return hints.length ? `${hints.join('\n')}\n\nDetails: ${detail}` : `Error: ${detail}`;
}
