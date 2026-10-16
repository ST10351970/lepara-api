import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';

/**
 * Where the customer's refresh token travels:
 *  - The website (a browser): in an httpOnly cookie its JavaScript can't read,
 *    sent only to /api/v1/auth. Browsers always send an Origin header with
 *    these requests, and requireTrustedOrigin only accepts the website's own.
 *  - The mobile app (no Origin header): in the reply body. The app keeps it
 *    in secure storage (expo-secure-store) and sends it back in the body.
 * So a browser never sees the token in a reply, and the app never needs cookies.
 */

export const REFRESH_COOKIE = 'lepara_refresh';
const COOKIE_PATH = '/api/v1/auth';

/** True for a browser (the website); false for the mobile app and tools. */
export function isBrowser(req: Request): boolean {
  return typeof req.headers.origin === 'string';
}

function cookieOptions(): CookieOptions {
  const live = env.NODE_ENV === 'production';
  return { httpOnly: true, secure: live, sameSite: live ? 'none' : 'lax', path: COOKIE_PATH };
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

const usable = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;

/** The refresh token: from the cookie for a browser, from the body for the app. */
export function readRefreshToken(req: Request): string | undefined {
  if (isBrowser(req)) return usable(req.cookies?.[REFRESH_COOKIE]);
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null
    ? usable((body as Record<string, unknown>).refreshToken)
    : undefined;
}
