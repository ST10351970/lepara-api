import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the server needs, checked once at start-up.
 * A missing or invalid value stops the server with a clear message,
 * instead of failing later in the middle of a request.
 */

const booleanFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const postgresUrl = z
  .string({ error: 'is required' })
  .min(1, 'is required')
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must start with postgres:// or postgresql://',
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: postgresUrl,
    DATABASE_SSL: booleanFlag('false'),
    DATABASE_SSL_REJECT_UNAUTHORIZED: booleanFlag('true'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((list) =>
        list
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.DATABASE_SSL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'must be true in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment variables:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Parses a set of variables. Pure, so tests can pass their own object. */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`,
    );
    throw new EnvError(problems);
  }
  return result.data;
}

function readEnvOrExit(): Env {
  try {
    return loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError && process.env.NODE_ENV !== 'test') {
      console.error(`\n${error.message}\n\nCopy .env.example to .env and fill in the values.\n`);
      process.exit(1);
    }
    throw error;
  }
}

export const env = readEnvOrExit();
