import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logs. Personal details and secrets are replaced with [hidden],
 * so logs can be shared for debugging without exposing anyone (POPIA).
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.confirmPassword',
      '*.code',
      '*.token',
      '*.refreshToken',
      '*.email',
      '*.contactNumber',
      '*.mobile',
      '*.phone',
      '*.phoneLast4',
    ],
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
