import type { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { errors } from '../utils/AppError';

/**
 * Protection against cross-site request forgery for endpoints that use the
 * sign-in cookie. Browsers always say which website a request comes from
 * (the Origin header); only the addresses in CORS_ORIGINS are accepted, plus
 * the API's own address, where the API docs page (/api/docs) runs. The mobile
 * app, tests and tools like Postman send no Origin and are not affected (they
 * don't use the cookie).
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (origin !== undefined && !env.CORS_ORIGINS.includes(origin) && origin !== ownOrigin(req)) {
    throw errors.forbidden('This request is not allowed from this website.');
  }
  next();
};

/**
 * The API's own address, such as https://lepara-api.onrender.com. A request
 * from there is not cross-site: it comes from the docs page's "Try it out".
 * (With TRUST_PROXY=1, req.protocol is the https the visitor used.)
 */
function ownOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? ''}`;
}

/** Replies with tokens must never be stored by a browser or proxy cache. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
