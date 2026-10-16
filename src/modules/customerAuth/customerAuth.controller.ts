import type { Request, Response } from 'express';
import { currentCustomer } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import {
  clearRefreshCookie,
  isBrowser,
  readRefreshToken,
  setRefreshCookie,
} from './customerAuth.cookies';
import type {
  ChangePasswordInput,
  DeleteAccountInput,
  ForgotPasswordInput,
  LoginInput,
  LoginVerifyInput,
  RegisterInput,
  ResendCodeInput,
  ResetPasswordInput,
  TwoFactorInput,
  UpdateProfileInput,
  VerifyEmailInput,
  VerifyNewEmailInput,
} from './customerAuth.schemas';
import * as service from './customerAuth.service';
import type { RequestContext, Session } from './customerAuth.service';

/** Thin layer: read the request, call the service, send the reply. */

function contextOf(req: Request): RequestContext {
  return { userAgent: req.get('user-agent')?.slice(0, 255) ?? null };
}

/**
 * The website (a browser) gets the refresh token in an httpOnly cookie and
 * never in the reply; the mobile app gets it in the reply, for secure storage.
 */
function sendSession(req: Request, res: Response, session: Session): void {
  const { refreshToken, refreshExpiresAt, ...reply } = session;
  if (isBrowser(req)) {
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    ok(res, reply);
  } else {
    ok(res, { ...reply, refreshToken, refreshExpiresAt });
  }
}

/** POST /auth/register */
export async function register(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: RegisterInput }>(res);
  created(res, await service.register(body));
}

/** POST /auth/verify-email */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: VerifyEmailInput }>(res);
  sendSession(req, res, await service.verifyEmail(body, contextOf(req)));
}

/** POST /auth/resend-code */
export async function resendCode(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ResendCodeInput }>(res);
  ok(res, await service.resendCode(body));
}

/** POST /auth/login: signed in, or { twoFactorRequired, pendingToken } when login codes are on. */
export async function login(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: LoginInput }>(res);
  const result = await service.signIn(body, contextOf(req));
  if ('twoFactorRequired' in result) ok(res, result);
  else sendSession(req, res, result);
}

/** POST /auth/login/verify */
export async function verifyLogin(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: LoginVerifyInput }>(res);
  sendSession(req, res, await service.verifyLoginCode(body, contextOf(req)));
}

/** POST /auth/refresh: the cookie (website) or { refreshToken } (app). */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    sendSession(req, res, await service.refreshSession(readRefreshToken(req), contextOf(req)));
  } catch (error) {
    if (isBrowser(req)) clearRefreshCookie(res);
    throw error;
  }
}

/** POST /auth/logout */
export async function logout(req: Request, res: Response): Promise<void> {
  await service.signOut(readRefreshToken(req));
  if (isBrowser(req)) clearRefreshCookie(res);
  ok(res, { signedOut: true });
}

/** POST /auth/forgot-password */
export async function forgotPassword(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ForgotPasswordInput }>(res);
  ok(res, await service.forgotPassword(body));
}

/** POST /auth/reset-password */
export async function resetPassword(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ResetPasswordInput }>(res);
  ok(res, await service.resetPassword(body));
}

// --- /me --------------------------------------------------------------------------------------

/** GET /me */
export async function me(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getProfile(currentCustomer(res).customerId));
}

/** PATCH /me */
export async function updateMe(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: UpdateProfileInput }>(res);
  ok(res, await service.updateProfile(currentCustomer(res).customerId, body));
}

/** POST /me/email/verify */
export async function verifyNewEmail(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: VerifyNewEmailInput }>(res);
  ok(res, await service.verifyNewEmail(currentCustomer(res).customerId, body));
}

/** PATCH /me/password: other devices are signed out; this one gets a fresh session. */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ChangePasswordInput }>(res);
  const session = await service.changePassword(
    currentCustomer(res).customerId,
    body,
    contextOf(req),
  );
  sendSession(req, res, session);
}

/** PATCH /me/two-factor */
export async function setTwoFactor(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: TwoFactorInput }>(res);
  ok(res, await service.setTwoFactor(currentCustomer(res).customerId, body));
}

/** DELETE /me */
export async function deleteMe(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: DeleteAccountInput }>(res);
  await service.deleteAccount(currentCustomer(res).customerId, body);
  if (isBrowser(req)) clearRefreshCookie(res);
  ok(res, { deleted: true });
}
