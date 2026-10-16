import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { randomToken, sha256Hex } from '../../utils/crypto';

/**
 * The customer tokens. Same design as the admin ones, but signed with a
 * different secret (JWT_CUSTOMER_SECRET) and audience, so a customer token
 * can never be used on an admin route, or the other way round.
 *
 * - Access token (JWT, 15 minutes): "Authorization: Bearer ..." on /me and
 *   order requests.
 * - Sign-in token (JWT, 10 minutes): only when emailed login codes are on;
 *   it proves the password was right and works only for /auth/login/verify.
 * - Refresh token (random, 7 days): the app keeps it in secure storage, the
 *   website in an httpOnly cookie. Replaced on every use; only its hash is stored.
 */

const ISSUER = 'lepara-api';
const ACCESS_AUDIENCE = 'lepara-customer';
const SIGN_IN_AUDIENCE = 'lepara-customer-sign-in';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const SIGN_IN_TOKEN_SECONDS = 10 * 60;
export const REFRESH_DAYS = 7;

export type CustomerTokenClaims = { customerId: number; sessionVersion: number };

export function signAccessToken(customerId: number, sessionVersion: number): string {
  return jwt.sign({ sv: sessionVersion }, env.JWT_CUSTOMER_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_SECONDS,
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    subject: String(customerId),
  });
}

export function signSignInToken(
  customerId: number,
  sessionVersion: number,
): { token: string; expiresIn: number } {
  const token = jwt.sign({ sv: sessionVersion }, env.JWT_CUSTOMER_SECRET, {
    algorithm: 'HS256',
    expiresIn: SIGN_IN_TOKEN_SECONDS,
    issuer: ISSUER,
    audience: SIGN_IN_AUDIENCE,
    subject: String(customerId),
  });
  return { token, expiresIn: SIGN_IN_TOKEN_SECONDS };
}

const claimsSchema = z.object({
  sub: z.string().regex(/^[1-9]\d{0,9}$/),
  sv: z.number().int().min(0),
});

type CheckResult = { ok: true; claims: CustomerTokenClaims } | { ok: false; expired: boolean };

function check(token: string, audience: string): CheckResult {
  try {
    const payload = jwt.verify(token, env.JWT_CUSTOMER_SECRET, {
      algorithms: ['HS256'], // never accept "none" or another algorithm
      issuer: ISSUER,
      audience,
    });
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, expired: false };
    return {
      ok: true,
      claims: { customerId: Number(parsed.data.sub), sessionVersion: parsed.data.sv },
    };
  } catch (error) {
    return { ok: false, expired: error instanceof jwt.TokenExpiredError };
  }
}

/** Reads an access token, or throws 401. Expired gives TOKEN_EXPIRED, so the app refreshes. */
export function readAccessToken(token: string): CustomerTokenClaims {
  const result = check(token, ACCESS_AUDIENCE);
  if (!result.ok) {
    throw result.expired
      ? new AppError(
          401,
          ErrorCode.TOKEN_EXPIRED,
          'Your session has expired. Please sign in again.',
        )
      : errors.unauthorized();
  }
  return result.claims;
}

export const signInExpired = () =>
  errors.unauthorized('Your sign-in took too long or was interrupted. Please sign in again.');

/** Reads the sign-in token from the login-code step, or throws 401. */
export function readSignInToken(token: string): CustomerTokenClaims {
  const result = check(token, SIGN_IN_AUDIENCE);
  if (!result.ok) throw signInExpired();
  return result.claims;
}

/** A new refresh token and the hash that gets stored. The token itself is never stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

export const hashRefreshToken = (token: string) => sha256Hex(token);
