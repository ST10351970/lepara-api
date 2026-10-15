import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { randomToken, sha256Hex } from '../../utils/crypto';

/**
 * The three kinds of admin token:
 *
 * - Access token (JWT, 15 minutes): sent as "Authorization: Bearer ..." on
 *   every admin request. Short-lived, so a leaked one is soon useless.
 * - Sign-in token (JWT, 5 or 10 minutes): proves the password was right.
 *   It only works for the two-factor step, never for admin pages.
 * - Refresh token (random, 12 hours): kept in an httpOnly cookie the
 *   website's JavaScript cannot read. It gets new access tokens, is replaced
 *   on every use, and only its SHA-256 hash is stored.
 *
 * Access and sign-in tokens use different audiences, so one can never be
 * used as the other.
 */

const ISSUER = 'lepara-api';
const ACCESS_AUDIENCE = 'lepara-admin';
const SIGN_IN_AUDIENCE = 'lepara-admin-sign-in';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const SETUP_TOKEN_SECONDS = 10 * 60; // time to install an app and scan the QR code
export const VERIFY_TOKEN_SECONDS = 5 * 60;
export const SESSION_HOURS = 12;

export type SignInPurpose = 'setup' | 'verify';

export type AdminTokenClaims = { adminId: number; sessionVersion: number };

export function signAccessToken(adminId: number, sessionVersion: number): string {
  return jwt.sign({ sv: sessionVersion }, env.JWT_ADMIN_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_SECONDS,
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    subject: String(adminId),
  });
}

export function signSignInToken(
  adminId: number,
  sessionVersion: number,
  purpose: SignInPurpose,
): { token: string; expiresIn: number } {
  const expiresIn = purpose === 'setup' ? SETUP_TOKEN_SECONDS : VERIFY_TOKEN_SECONDS;
  const token = jwt.sign({ sv: sessionVersion, purpose }, env.JWT_ADMIN_SECRET, {
    algorithm: 'HS256',
    expiresIn,
    issuer: ISSUER,
    audience: SIGN_IN_AUDIENCE,
    subject: String(adminId),
  });
  return { token, expiresIn };
}

const claimsSchema = z.object({
  sub: z.string().regex(/^[1-9]\d{0,9}$/),
  sv: z.number().int().min(0),
  purpose: z.enum(['setup', 'verify']).optional(),
});

type CheckResult =
  | { ok: true; claims: z.infer<typeof claimsSchema> }
  | { ok: false; expired: boolean };

function check(token: string, audience: string): CheckResult {
  try {
    const payload = jwt.verify(token, env.JWT_ADMIN_SECRET, {
      algorithms: ['HS256'], // never accept "none" or another algorithm
      issuer: ISSUER,
      audience,
    });
    const parsed = claimsSchema.safeParse(payload);
    return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, expired: false };
  } catch (error) {
    return { ok: false, expired: error instanceof jwt.TokenExpiredError };
  }
}

/** Reads an access token, or throws 401. An expired one gives TOKEN_EXPIRED, so the website refreshes. */
export function readAccessToken(token: string): AdminTokenClaims {
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
  return { adminId: Number(result.claims.sub), sessionVersion: result.claims.sv };
}

export function signInExpired(): AppError {
  return errors.unauthorized('Your sign-in took too long or was interrupted. Please start again.');
}

/** Reads a sign-in token for one step, or throws 401. */
export function readSignInToken(token: string, purpose: SignInPurpose): AdminTokenClaims {
  const result = check(token, SIGN_IN_AUDIENCE);
  if (!result.ok || result.claims.purpose !== purpose) throw signInExpired();
  return { adminId: Number(result.claims.sub), sessionVersion: result.claims.sv };
}

/** A new refresh token and the hash that gets stored. The token itself is never stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}
