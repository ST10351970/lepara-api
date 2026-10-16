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

/** An optional setting: missing, empty or only spaces all mean "not set". */
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

export type FirebaseServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

/**
 * The Firebase service account key file (JSON), pasted as it is or in base64.
 * Returns null if it isn't one. Only the three fields the API needs are kept.
 */
export function parseServiceAccount(text: string): FirebaseServiceAccount | null {
  const raw = text.trim();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { project_id, client_email, private_key } = parsed as Record<string, unknown>;
  if (
    typeof project_id !== 'string' ||
    typeof client_email !== 'string' ||
    typeof private_key !== 'string' ||
    !private_key.includes('PRIVATE KEY')
  ) {
    return null;
  }
  // A key copied with its line breaks written out as \n still works.
  return {
    projectId: project_id,
    clientEmail: client_email,
    privateKey: private_key.replace(/\\n/g, '\n'),
  };
}

const MAIL_FROM_PATTERN =
  /^([^<>@]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

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

    // Admin sign-in. See .env.example for how to make each value.
    JWT_ADMIN_SECRET: z
      .string({ error: 'is required: a long random value (see .env.example)' })
      .min(32, 'must be at least 32 characters (see .env.example)'),
    TOTP_ENCRYPTION_KEY: z
      .string({ error: 'is required: 64 hex characters (see .env.example)' })
      .regex(/^[0-9a-fA-F]{64}$/, 'must be exactly 64 hex characters (see .env.example)'),

    // Customer sign-in (the shop accounts). A different value from JWT_ADMIN_SECRET.
    JWT_CUSTOMER_SECRET: z
      .string({ error: 'is required: a long random value (see .env.example)' })
      .min(32, 'must be at least 32 characters (see .env.example)'),

    // Photo uploads (Azure Blob Storage). Optional: without them, uploads answer 503.
    AZURE_STORAGE_CONNECTION_STRING: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined)
      .refine(
        (value) => value === undefined || /AccountName=[^;]+/.test(value),
        'must be the connection string from the storage account (see .env.example)',
      ),
    AZURE_STORAGE_CONTAINER: z
      .string()
      .default('images')
      .refine(
        (value) => /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(value),
        'must be 3 to 63 lower-case letters, numbers or dashes',
      ),

    // Email. Optional: with neither BREVO_API_KEY nor SMTP_HOST, development uses
    // a test inbox at ethereal.email and the live API only logs that an email was
    // skipped. BREVO_API_KEY sends over HTTPS, which works on Render's free plan
    // (it blocks SMTP ports); SMTP works anywhere else (Brevo, Gmail, ...).
    BREVO_API_KEY: optionalText,
    SMTP_HOST: optionalText,
    SMTP_PORT: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce
        .number({ error: 'must be a port number, usually 587' })
        .int()
        .min(1)
        .max(65535)
        .default(587),
    ),
    /** true for port 465. Left empty, it is worked out from the port. */
    SMTP_SECURE: z
      .enum(['true', 'false', ''], { error: 'must be true, false or empty' })
      .optional()
      .transform((value) => (value ? value === 'true' : undefined)),
    SMTP_USER: optionalText,
    SMTP_PASS: optionalText,
    MAIL_FROM: optionalText.refine(
      (value) => value === undefined || MAIL_FROM_PATTERN.test(value),
      'must be an email address, for example: Lepara Ale fele Moya <hello@example.org>',
    ),

    // Shop. The delivery fee in cents (6000 is R60), added once to every order.
    DELIVERY_FEE_CENTS: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined)
      .refine(
        (value) => value === undefined || /^\d{1,6}$/.test(value),
        'must be a whole number of cents, for example 6000 for R60',
      )
      .transform((value) => (value === undefined ? 6000 : Number(value)))
      .refine(
        (cents) => cents === 0 || (cents >= 100 && cents <= 100_000),
        'is in cents: 6000 is R60 (0 for free delivery, at most 100000)',
      ),
    // The bank account customers pay into for EFT orders. Optional, but all four go
    // together: without them, EFT orders show the reference and amount only.
    EFT_BANK_NAME: optionalText,
    EFT_ACCOUNT_NAME: optionalText,
    EFT_ACCOUNT_NUMBER: optionalText.refine(
      (value) => value === undefined || /^\d[\d ]{4,24}$/.test(value),
      'must be the account number (digits only)',
    ),
    // Push notifications (Firebase Cloud Messaging). Optional: without it, devices are
    // still registered and each notification is skipped with a line in the log.
    FIREBASE_SERVICE_ACCOUNT: optionalText.transform((value, ctx) => {
      if (value === undefined) return undefined;
      const account = parseServiceAccount(value);
      if (!account) {
        ctx.addIssue({
          code: 'custom',
          message:
            'must be the contents of the Firebase service account key file, or the same in ' +
            'base64 (see .env.example)',
        });
        return z.NEVER;
      }
      return account;
    }),
    EFT_BRANCH_CODE: optionalText.refine(
      (value) => value === undefined || /^\d{6}$/.test(value),
      'must be the 6-digit branch code',
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.DATABASE_SSL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'must be true in production',
      });
    }
    if ((env.BREVO_API_KEY || env.SMTP_HOST) && !env.MAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: 'is required for sending email (the sender people see on emails)',
      });
    }
    if (env.JWT_CUSTOMER_SECRET === env.JWT_ADMIN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_CUSTOMER_SECRET'],
        message: 'must be different from JWT_ADMIN_SECRET',
      });
    }
    const bank = [
      'EFT_BANK_NAME',
      'EFT_ACCOUNT_NAME',
      'EFT_ACCOUNT_NUMBER',
      'EFT_BRANCH_CODE',
    ] as const;
    const missing = bank.filter((key) => !env[key]);
    if (missing.length > 0 && missing.length < bank.length) {
      for (const key of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required: the four EFT_ bank settings go together (set all or none)',
        });
      }
    }
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SMTP_USER ? 'SMTP_PASS' : 'SMTP_USER'],
        message: 'is required: SMTP_USER and SMTP_PASS go together',
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
