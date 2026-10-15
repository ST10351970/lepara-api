import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';

/**
 * The refresh token lives in a cookie that:
 *  - httpOnly: the website's JavaScript can't read it, so an injected script can't steal it;
 *  - secure (live site): only travels over HTTPS;
 *  - sameSite: "lax" locally; "none" on the live site, because the website and
 *    the API are on different addresses (the Origin check in
 *    middleware/trustedOrigin.ts guards against other sites using it);
 *  - path: only sent to /api/v1/admin/auth, never to other endpoints.
 */

export const REFRESH_COOKIE = 'lepara_admin_refresh';
const COOKIE_PATH = '/api/v1/admin/auth';

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

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}
