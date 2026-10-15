import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  hashRefreshToken,
  newRefreshToken,
  readAccessToken,
  readSignInToken,
  signAccessToken,
  signSignInToken,
} from '../../src/modules/adminAuth/adminAuth.tokens';
import { AppError } from '../../src/utils/AppError';

const secret = process.env.JWT_ADMIN_SECRET!;

/** The error a function throws, so its status and code can be checked. */
function thrownBy(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected an error, but none was thrown.');
}

describe('access tokens', () => {
  it('carry the admin and the session version', () => {
    expect(readAccessToken(signAccessToken(7, 3))).toEqual({ adminId: 7, sessionVersion: 3 });
  });

  it('report an expired token as TOKEN_EXPIRED, so the website refreshes', () => {
    const expired = jwt.sign({ sv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, secret, {
      algorithm: 'HS256',
      issuer: 'lepara-api',
      audience: 'lepara-admin',
      subject: '7',
    });
    expect(thrownBy(() => readAccessToken(expired))).toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
  });

  it('refuse a token signed with another secret', () => {
    const forged = jwt.sign({ sv: 0 }, 'someone-elses-secret-that-is-long-enough', {
      algorithm: 'HS256',
      issuer: 'lepara-api',
      audience: 'lepara-admin',
      subject: '1',
      expiresIn: 900,
    });
    expect(thrownBy(() => readAccessToken(forged))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('refuse an unsigned token (alg "none")', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '1', sv: 0, iss: 'lepara-api', aud: 'lepara-admin' }),
    ).toString('base64url');
    expect(thrownBy(() => readAccessToken(`${header}.${payload}.`)).status).toBe(401);
  });

  it('refuse a token whose content was edited', () => {
    const [header, , signature] = signAccessToken(7, 0).split('.');
    const payload = Buffer.from(
      JSON.stringify({ sub: '1', sv: 0, iss: 'lepara-api', aud: 'lepara-admin' }),
    ).toString('base64url');
    expect(thrownBy(() => readAccessToken(`${header}.${payload}.${signature}`)).status).toBe(401);
  });
});

describe('sign-in tokens', () => {
  it('work only for the step they were made for', () => {
    const { token, expiresIn } = signSignInToken(7, 0, 'verify');
    expect(expiresIn).toBe(300);
    expect(readSignInToken(token, 'verify')).toEqual({ adminId: 7, sessionVersion: 0 });
    expect(thrownBy(() => readSignInToken(token, 'setup')).status).toBe(401);
  });

  it('give 10 minutes for setting up the authenticator app', () => {
    expect(signSignInToken(7, 0, 'setup').expiresIn).toBe(600);
  });

  it('can never be used as an access token, and the other way round', () => {
    const signInToken = signSignInToken(7, 0, 'verify').token;
    expect(thrownBy(() => readAccessToken(signInToken)).status).toBe(401);
    expect(thrownBy(() => readSignInToken(signAccessToken(7, 0), 'verify')).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('are random, and only their hash is kept', () => {
    const first = newRefreshToken();
    expect(first.token).toMatch(/^[\w-]{43}$/);
    expect(first.hash).toBe(hashRefreshToken(first.token));
    expect(first.hash).not.toContain(first.token);
    expect(newRefreshToken().token).not.toBe(first.token);
  });
});
