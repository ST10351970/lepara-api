import pino from 'pino';
import { env } from '../config/env';

/**
 * Anything that could be a secret or a personal detail. Request bodies are
 * never logged anyway (see app.ts); this is a second line of defence for
 * anything logged by hand.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.confirmPassword',
  '*.code',
  '*.backupCodes',
  '*.token',
  '*.pendingToken',
  '*.accessToken',
  '*.refreshToken',
  '*.manualEntryKey',
  '*.otpauthUrl',
  '*.qrCodeDataUrl',
  '*.email',
  '*.contactNumber',
  '*.mobile',
  '*.phone',
  '*.phoneLast4',
];

/**
 * Structured logs. Personal details and secrets are replaced with [hidden],
 * so logs can be shared for debugging without exposing anyone (POPIA).
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[hidden]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
