import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { ok } from '../../utils/respond';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './adminAuth.cookies';
import type {
  ChangePasswordInput,
  ConfirmTwoFactorInput,
  LoginInput,
  SignInTokenInput,
  VerifyTwoFactorInput,
} from './adminAuth.schemas';
import * as service from './adminAuth.service';
import type { RequestContext, Session } from './adminAuth.service';

/** Thin layer: read the request, call the service, send the reply. */

function contextOf(req: Request): RequestContext {
  return { userAgent: req.get('user-agent')?.slice(0, 255) ?? null };
}

/** Puts the refresh token in the cookie and replies with everything else. */
function sendSession(res: Response, session: Session, extra: Record<string, unknown> = {}): void {
  const { refreshToken, refreshExpiresAt, ...reply } = session;
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  ok(res, { ...reply, ...extra });
}

/** POST /admin/auth/login */
export async function login(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: LoginInput }>(res);
  ok(res, await service.signIn(body));
}

/** POST /admin/auth/2fa/setup */
export async function startTwoFactorSetup(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: SignInTokenInput }>(res);
  ok(res, await service.startTwoFactorSetup(body.pendingToken));
}

/** POST /admin/auth/2fa/confirm: the backup codes are shown once, here, and never again. */
export async function confirmTwoFactorSetup(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ConfirmTwoFactorInput }>(res);
  const { backupCodes, ...session } = await service.confirmTwoFactorSetup(body, contextOf(req));
  sendSession(res, session, { backupCodes });
}

/** POST /admin/auth/2fa/verify */
export async function verifyTwoFactor(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: VerifyTwoFactorInput }>(res);
  sendSession(res, await service.verifyTwoFactor(body, contextOf(req)));
}

/** POST /admin/auth/refresh: uses the cookie, so the website calls it with credentials: 'include'. */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    sendSession(res, await service.refreshSession(readRefreshCookie(req), contextOf(req)));
  } catch (error) {
    clearRefreshCookie(res);
    throw error;
  }
}

/** POST /admin/auth/logout */
export async function logout(req: Request, res: Response): Promise<void> {
  await service.signOut(readRefreshCookie(req));
  clearRefreshCookie(res);
  ok(res, { signedOut: true });
}

/** POST /admin/auth/logout-all */
export async function logoutEverywhere(_req: Request, res: Response): Promise<void> {
  await service.signOutEverywhere(currentAdmin(res).adminId);
  clearRefreshCookie(res);
  ok(res, { signedOut: true });
}

/** GET /admin/me */
export async function me(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getProfile(currentAdmin(res).adminId));
}

/** PATCH /admin/me/password: other devices are signed out; this one gets a fresh session. */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: ChangePasswordInput }>(res);
  sendSession(res, await service.changePassword(currentAdmin(res).adminId, body, contextOf(req)));
}
