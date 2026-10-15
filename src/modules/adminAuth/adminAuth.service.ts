import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { type Queryable, withTransaction } from '../../config/db';
import { AppError, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { decryptSecret, encryptSecret } from '../../utils/crypto';
import { hashPassword, verifyPassword } from '../../utils/passwords';
import {
  formatSecretForTyping,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '../../utils/totp';
import { generateBackupCodes, hashBackupCode } from './adminAuth.codes';
import * as repo from './adminAuth.repository';
import type { AdminAuthRow, AdminRole } from './adminAuth.repository';
import type {
  ChangePasswordInput,
  ConfirmTwoFactorInput,
  LoginInput,
  VerifyTwoFactorInput,
} from './adminAuth.schemas';
import {
  ACCESS_TOKEN_SECONDS,
  SESSION_HOURS,
  type SignInPurpose,
  hashRefreshToken,
  newRefreshToken,
  readSignInToken,
  signAccessToken,
  signInExpired,
  signSignInToken,
} from './adminAuth.tokens';

/**
 * Admin sign-in, step by step:
 *
 *   1. login: username + password.                     -> a short-lived sign-in token
 *   2a. First time: 2fa/setup shows a QR code, and
 *       2fa/confirm checks the first code.            -> signed in + 10 backup codes
 *   2b. Afterwards: 2fa/verify checks the app's code
 *       (or a backup code).                            -> signed in
 *   3. refresh swaps the refresh cookie for a new access token, every 15 minutes.
 *
 * Wrong passwords AND wrong codes both count towards the lock: 5 in a row
 * lock the account for 15 minutes.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
/** A refresh token replaced less than this long ago is a second tab, not a thief. */
export const ROTATION_GRACE_SECONDS = 10;
const TOTP_ISSUER = 'Lepara Ale fele Moya';

export type RequestContext = { userAgent: string | null };

export type AdminProfile = {
  adminId: number;
  username: string;
  fullName: string;
  email: string;
  role: AdminRole;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  backupCodesRemaining: number;
};

/** A signed-in session. The controller puts refreshToken in the cookie, never in the reply. */
export type Session = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  admin: AdminProfile;
  refreshToken: string;
  refreshExpiresAt: Date;
};

export type SignInStep = {
  nextStep: 'two_factor_setup' | 'two_factor_verify';
  pendingToken: string;
  expiresIn: number;
};

// --- Messages ------------------------------------------------------------------

const wrongCredentials = () => errors.unauthorized('Your username or password is incorrect.');

const codeError = (message: string) => errors.validation([{ field: 'code', message }], message);
const wrongAppCode = () =>
  codeError('That code is incorrect. Please check your authenticator app and try again.');
const usedAppCode = () =>
  codeError('That code has already been used. Please wait for the next code in your app.');
const wrongBackupCode = () => codeError('That backup code is incorrect or has already been used.');

const sessionEnded = () => errors.unauthorized('Your session has ended. Please sign in again.');

function lockedError(lockedUntil: Date): AppError {
  // Rounded, so a few seconds' difference between the server and database clocks doesn't show.
  const minutes = Math.max(1, Math.round((lockedUntil.getTime() - Date.now()) / 60_000));
  return errors.locked(
    `Your account is locked after too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  );
}

function assertNotLocked(admin: AdminAuthRow): void {
  if (admin.locked_until && admin.locked_until.getTime() > Date.now()) {
    throw lockedError(admin.locked_until);
  }
}

/** Counts a failed attempt. Returns the error to throw: the lock message if this attempt locked the account. */
async function failedAttempt(admin: AdminAuthRow, error: AppError): Promise<AppError> {
  const lockedUntil = await repo.recordFailedAttempt(
    admin.admin_id,
    MAX_FAILED_ATTEMPTS,
    LOCK_MINUTES,
  );
  if (!lockedUntil) return error;
  await recordAudit({
    adminId: admin.admin_id,
    action: 'account_locked',
    tableName: 'admin_user',
    recordId: admin.admin_id,
    details: { minutes: LOCK_MINUTES },
  });
  return lockedError(lockedUntil);
}

// A real bcrypt hash to compare against when the username doesn't exist, so a
// wrong username takes as long as a wrong password and gives nothing away.
let dummyHash: Promise<string> | undefined;
const timingDummy = () => (dummyHash ??= hashPassword('not-a-real-password'));

// --- Step 1: password ----------------------------------------------------------

export async function signIn({ username, password }: LoginInput): Promise<SignInStep> {
  const admin = await repo.findAdminByUsername(username);
  if (!admin || !admin.is_active) {
    await verifyPassword(password, await timingDummy());
    throw wrongCredentials();
  }
  assertNotLocked(admin);

  if (!(await verifyPassword(password, admin.password_hash))) {
    throw await failedAttempt(admin, wrongCredentials());
  }

  const purpose: SignInPurpose = admin.two_factor_enabled ? 'verify' : 'setup';
  const { token, expiresIn } = signSignInToken(admin.admin_id, admin.session_version, purpose);
  return {
    nextStep: purpose === 'verify' ? 'two_factor_verify' : 'two_factor_setup',
    pendingToken: token,
    expiresIn,
  };
}

/** The admin a sign-in token belongs to, if it is still valid for this step. */
async function adminForSignInStep(token: string, purpose: SignInPurpose): Promise<AdminAuthRow> {
  const claims = readSignInToken(token, purpose);
  const admin = await repo.findAdminById(claims.adminId);
  if (!admin || !admin.is_active || admin.session_version !== claims.sessionVersion) {
    throw signInExpired();
  }
  assertNotLocked(admin);
  return admin;
}

// --- Step 2a: first sign-in, set up the authenticator app ----------------------

const alreadySetUp = () =>
  errors.conflict('Two-factor sign-in is already set up for this account. Please sign in again.');

export async function startTwoFactorSetup(pendingToken: string) {
  const admin = await adminForSignInStep(pendingToken, 'setup');
  if (admin.two_factor_enabled) throw alreadySetUp();

  // A new secret each time, so restarting set-up never reuses an old QR code.
  const secret = generateTotpSecret();
  if (!(await repo.saveTotpSecret(admin.admin_id, encryptSecret(secret)))) throw alreadySetUp();

  const url = otpauthUrl({ issuer: TOTP_ISSUER, account: admin.username, secret });
  return {
    qrCodeDataUrl: await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    }),
    otpauthUrl: url,
    manualEntryKey: formatSecretForTyping(secret),
  };
}

export async function confirmTwoFactorSetup(
  { pendingToken, code }: ConfirmTwoFactorInput,
  context: RequestContext,
): Promise<Session & { backupCodes: string[] }> {
  const admin = await adminForSignInStep(pendingToken, 'setup');
  if (admin.two_factor_enabled) throw alreadySetUp();
  const encryptedSecret = admin.totp_secret_encrypted;
  if (!encryptedSecret) {
    throw errors.badRequest('Please scan the QR code first, then enter the code your app shows.');
  }

  const step = verifyTotp(decryptSecret(encryptedSecret), code);
  if (step === null) throw await failedAttempt(admin, wrongAppCode());

  const backupCodes = generateBackupCodes();
  const session = await withTransaction(async (client) => {
    if (!(await repo.enableTwoFactor(client, admin.admin_id, encryptedSecret, step))) return null;
    await repo.replaceBackupCodes(client, admin.admin_id, backupCodes.map(hashBackupCode));
    await recordAudit(
      {
        adminId: admin.admin_id,
        action: 'two_factor_enabled',
        tableName: 'admin_user',
        recordId: admin.admin_id,
      },
      client,
    );
    return completeSignIn(client, admin.admin_id, context, 'authenticator');
  });
  // Set-up was restarted in another tab (new QR code) or finished there already.
  if (!session) throw signInExpired();
  return { ...session, backupCodes };
}

// --- Step 2b: every later sign-in ------------------------------------------------

export async function verifyTwoFactor(
  { pendingToken, code }: VerifyTwoFactorInput,
  context: RequestContext,
): Promise<Session> {
  const admin = await adminForSignInStep(pendingToken, 'verify');
  if (!admin.two_factor_enabled || !admin.totp_secret_encrypted) throw signInExpired();

  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decryptSecret(admin.totp_secret_encrypted), code);
    if (step === null) throw await failedAttempt(admin, wrongAppCode());
    if (admin.totp_last_used_step !== null && step <= admin.totp_last_used_step) {
      throw await failedAttempt(admin, usedAppCode());
    }
    const session = await withTransaction(async (client) =>
      (await repo.claimTotpStep(client, admin.admin_id, step))
        ? completeSignIn(client, admin.admin_id, context, 'authenticator')
        : null,
    );
    // Another request used the same code a moment earlier.
    if (!session) throw await failedAttempt(admin, usedAppCode());
    return session;
  }

  const session = await withTransaction(async (client) =>
    (await repo.useBackupCode(client, admin.admin_id, hashBackupCode(code)))
      ? completeSignIn(client, admin.admin_id, context, 'backup_code')
      : null,
  );
  if (!session) throw await failedAttempt(admin, wrongBackupCode());
  return session;
}

// --- Sessions -------------------------------------------------------------------

async function profileOf(admin: AdminAuthRow, db?: Queryable): Promise<AdminProfile> {
  return {
    adminId: admin.admin_id,
    username: admin.username,
    fullName: admin.full_name,
    email: admin.email,
    role: admin.role,
    twoFactorEnabled: admin.two_factor_enabled,
    mustChangePassword: admin.must_change_password,
    lastLoginAt: admin.last_login_at,
    backupCodesRemaining: await repo.countUnusedBackupCodes(admin.admin_id, db),
  };
}

/** Creates a refresh token (a new session, or the next token in an existing one) and an access token. */
async function issueSession(
  db: Queryable,
  admin: AdminAuthRow,
  context: RequestContext,
  existing?: { familyId: string; expiresAt: Date },
): Promise<Session> {
  const refresh = newRefreshToken();
  const refreshExpiresAt = await repo.insertRefreshToken(db, {
    adminId: admin.admin_id,
    tokenHash: refresh.hash,
    familyId: existing?.familyId ?? randomUUID(),
    expiresAt: existing?.expiresAt,
    hoursValid: SESSION_HOURS,
    userAgent: context.userAgent,
  });
  return {
    accessToken: signAccessToken(admin.admin_id, admin.session_version),
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_SECONDS,
    admin: await profileOf(admin, db),
    refreshToken: refresh.token,
    refreshExpiresAt,
  };
}

async function completeSignIn(
  db: Queryable,
  adminId: number,
  context: RequestContext,
  method: 'authenticator' | 'backup_code',
): Promise<Session> {
  const admin = await repo.recordSuccessfulSignIn(db, adminId);
  await repo.deleteOldRefreshTokens(db, adminId);
  await recordAudit(
    {
      adminId,
      action: 'signed_in',
      tableName: 'admin_user',
      recordId: adminId,
      details: { method },
    },
    db,
  );
  return issueSession(db, admin, context);
}

type RefreshOutcome = { kind: 'ok'; session: Session } | { kind: 'ended' } | { kind: 'stolen' };

/**
 * Swaps a refresh token for a new one plus a new access token. The old token
 * stops working. If an old, already-replaced token comes back later, someone
 * has a copy of it, so every session that admin has is ended.
 */
export async function refreshSession(
  refreshToken: string | undefined,
  context: RequestContext,
): Promise<Session> {
  if (!refreshToken) throw sessionEnded();

  const outcome = await withTransaction(async (client): Promise<RefreshOutcome> => {
    const token = await repo.findRefreshTokenForUpdate(client, hashRefreshToken(refreshToken));
    if (!token || token.expired) return { kind: 'ended' };

    if (token.revoked) {
      const justReplaced =
        token.revoke_reason === 'rotated' &&
        token.revoked_seconds_ago !== null &&
        token.revoked_seconds_ago < ROTATION_GRACE_SECONDS;

      if (!justReplaced) {
        if (token.revoke_reason !== 'rotated') return { kind: 'ended' };
        await repo.endAllSessions(client, token.admin_id, 'reuse_detected');
        await recordAudit(
          {
            adminId: token.admin_id,
            action: 'session_reuse_detected',
            tableName: 'admin_user',
            recordId: token.admin_id,
          },
          client,
        );
        return { kind: 'stolen' };
      }
      // Two tabs refreshed at the same moment: fine, as long as the session is still open.
      if (!(await repo.familyIsActive(client, token.family_id))) return { kind: 'ended' };
    }

    const admin = await repo.findAdminById(token.admin_id, client);
    if (!admin || !admin.is_active) {
      await repo.revokeFamily(client, token.family_id, 'account_deactivated');
      return { kind: 'ended' };
    }
    if (!token.revoked) await repo.revokeRefreshToken(client, token.token_id, 'rotated');

    const session = await issueSession(client, admin, context, {
      familyId: token.family_id,
      expiresAt: token.expires_at,
    });
    return { kind: 'ok', session };
  });

  if (outcome.kind === 'stolen') {
    throw errors.unauthorized(
      'For your safety, you have been signed out on all devices. Please sign in again.',
    );
  }
  if (outcome.kind === 'ended') throw sessionEnded();
  return outcome.session;
}

/** Signs out this browser. Always succeeds, even if the session had already ended. */
export async function signOut(refreshToken: string | undefined): Promise<void> {
  if (refreshToken) await repo.revokeFamilyByTokenHash(hashRefreshToken(refreshToken));
}

/** Signs out every browser and device, for example after losing a laptop. */
export async function signOutEverywhere(adminId: number): Promise<void> {
  await withTransaction(async (client) => {
    await repo.endAllSessions(client, adminId, 'signed_out_everywhere');
    await recordAudit(
      { adminId, action: 'signed_out_everywhere', tableName: 'admin_user', recordId: adminId },
      client,
    );
  });
}

// --- Signed-in admin -------------------------------------------------------------

export async function getProfile(adminId: number): Promise<AdminProfile> {
  const admin = await repo.findAdminById(adminId);
  if (!admin) throw errors.unauthorized();
  return profileOf(admin);
}

/**
 * Changes the password, ends every other session, and starts a fresh one
 * here so the admin stays signed in on this browser.
 */
export async function changePassword(
  adminId: number,
  { currentPassword, newPassword }: ChangePasswordInput,
  context: RequestContext,
): Promise<Session> {
  const admin = await repo.findAdminById(adminId);
  if (!admin) throw errors.unauthorized();

  if (!(await verifyPassword(currentPassword, admin.password_hash))) {
    throw errors.validation([
      { field: 'currentPassword', message: 'Your current password is incorrect.' },
    ]);
  }
  if (newPassword === currentPassword) {
    throw errors.validation([
      {
        field: 'newPassword',
        message: 'Please choose a new password that is different from your current one.',
      },
    ]);
  }

  const passwordHash = await hashPassword(newPassword);
  return withTransaction(async (client) => {
    await repo.updatePassword(client, adminId, passwordHash);
    const updated = await repo.endAllSessions(client, adminId, 'password_changed');
    await recordAudit(
      { adminId, action: 'password_changed', tableName: 'admin_user', recordId: adminId },
      client,
    );
    return issueSession(client, updated, context);
  });
}
