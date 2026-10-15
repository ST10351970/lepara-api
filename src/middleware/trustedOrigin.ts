import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { errors } from '../utils/AppError';

/**
 * Protection against cross-site request forgery for endpoints that use the
 * sign-in cookie. Browsers always say which website a request comes from
 * (the Origin header); only the addresses in CORS_ORIGINS are accepted.
 * The mobile app, tests and tools like Postman send no Origin and are not
 * affected (they don't use the cookie).
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (origin !== undefined && !env.CORS_ORIGINS.includes(origin)) {
    throw errors.forbidden('This request is not allowed from this website.');
  }
  next();
};

/** Replies with tokens must never be stored by a browser or proxy cache. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
