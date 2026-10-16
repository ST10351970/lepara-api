import { randomUUID } from 'node:crypto';
import { type Queryable, pool, withTransaction } from '../../config/db';
import { sendEmailInBackground } from '../../services/email';
import {
  customerAccountDeleted,
  customerAlreadyRegistered,
  customerEmailAlreadyUsed,
  customerEmailChangeCode,
  customerLoginCode,
  customerPasswordChanged,
  customerPasswordResetCode,
  customerSignUpCode,
} from '../../services/emailTemplates';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { hashPassword, verifyPassword } from '../../utils/passwords';
import { constraintOf } from '../../utils/pgErrors';
import {
  type CodePurpose,
  codeMatches,
  generateCode,
  hashCode,
  sendThrottle,
} from './customerAuth.codes';
import * as repo from './customerAuth.repository';
import type { CustomerRow } from './customerAuth.repository';
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
import {
  ACCESS_TOKEN_SECONDS,
  REFRESH_DAYS,
  hashRefreshToken,
  newRefreshToken,
  readSignInToken,
  signAccessToken,
  signInExpired,
  signSignInToken,
} from './customerAuth.tokens';

/**
 * Customer accounts for the shop:
 *
 *   register → a 6-digit code by email → verify-email → signed in
 *   login → signed in, or (with login codes on) a code by email → login/verify
 *   refresh swaps the refresh token for a new pair, every 15 minutes
 *
 * Nothing here tells a stranger whether an email address has an account:
 * registering, resending and "forgot password" reply the same either way,
 * and the email itself says what happened.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
/** A refresh token replaced less than this long ago is a second request, not a thief. */
export const ROTATION_GRACE_SECONDS = 10;

export type RequestContext = { userAgent: string | null };

export type CustomerProfile = {
  customerId: number;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  /** Login codes by email are on. */
  twoFactorEnabled: boolean;
  /** A new email address waiting for its code, if a change was started. */
  pendingEmail: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

/** A signed-in session. The controller decides where the refresh token goes (cookie or body). */
export type Session = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  customer: CustomerProfile;
  refreshToken: string;
  refreshExpiresAt: Date;
};

export type LoginCodeStep = { twoFactorRequired: true; pendingToken: string; expiresIn: number };

// --- Messages -------------------------------------------------------------------------------

const CHECK_EMAIL = 'Check your email for a 6-digit code.';

const wrongCredentials = () => errors.unauthorized('Your email or password is incorrect.');
const sessionEnded = () => errors.unauthorized('Your session has ended. Please sign in again.');

const codeError = (message: string) => errors.validation([{ field: 'code', message }], message);

/** The same message for a wrong, expired or used-up code, and for an unknown email. */
const genericCodeError = () =>
  codeError(
    'That code is incorrect or has expired. Please check the latest email, or ask for a new code.',
  );

/** "That code is incorrect. You have 3 tries left." */
const wrongCodeWithTriesLeft = (left: number) =>
  codeError(`That code is incorrect. You have ${left} ${left === 1 ? 'try' : 'tries'} left.`);

const notVerified = () =>
  new AppError(
    403,
    ErrorCode.EMAIL_NOT_VERIFIED,
    'Please confirm your email address first: enter the code we emailed you, or ask for a new one.',
  );

const waitBeforeResending = (seconds: number) =>
  new AppError(
    429,
    ErrorCode.RATE_LIMITED,
    `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before asking for another code.`,
  );

function lockedError(lockedUntil: Date): AppError {
  const minutes = Math.max(1, Math.round((lockedUntil.getTime() - Date.now()) / 60_000));
  return errors.locked(
    `Your account is locked after too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  );
}

function assertNotLocked(customer: CustomerRow): void {
  if (customer.locked_until && customer.locked_until.getTime() > Date.now()) {
    throw lockedError(customer.locked_until);
  }
}

/** Counts a failed attempt; returns the error to throw (the lock message if this one locked it). */
async function failedAttempt(customer: CustomerRow, error: AppError): Promise<AppError> {
  const lockedUntil = await repo.recordFailedAttempt(
    customer.customer_id,
    MAX_FAILED_ATTEMPTS,
    LOCK_MINUTES,
  );
  return lockedUntil ? lockedError(lockedUntil) : error;
}

async function checkPassword(customer: CustomerRow, password: string, field: string) {
  assertNotLocked(customer);
  if (!(await verifyPassword(password, customer.password_hash))) {
    throw await failedAttempt(
      customer,
      errors.validation([{ field, message: 'Your password is incorrect.' }]),
    );
  }
}

// A real bcrypt hash to compare against when the email is unknown, so an
// unknown email takes as long as a wrong password and gives nothing away.
let dummyHash: Promise<string> | undefined;
const timingDummy = () => (dummyHash ??= hashPassword('not-a-real-password'));

// --- Codes ------------------------------------------------------------------------------------

/** Saves a new code (cancelling older ones for the purpose) and returns it for the email. */
async function newCode(
  db: Queryable,
  customerId: number,
  purpose: CodePurpose,
  newEmail?: string,
): Promise<string> {
  const code = generateCode();
  await repo.saveCode(db, { customerId, purpose, codeHash: hashCode(code), newEmail });
  return code;
}

type CodeCheck<T> = { kind: 'ok'; value: T } | { kind: 'none' } | { kind: 'wrong'; left: number };

/**
 * Checks a code in its own transaction, so a wrong try is counted (and saved)
 * even though the request then fails. `onMatch` runs in the same transaction
 * as using up the code, so both happen or neither does.
 */
async function useCodeThen<T>(
  customerId: number,
  purpose: CodePurpose,
  code: string,
  onMatch: (db: Queryable, row: repo.CodeRow) => Promise<T>,
): Promise<CodeCheck<T>> {
  return withTransaction(async (client) => {
    const row = await repo.findUsableCode(client, customerId, purpose);
    if (!row) return { kind: 'none' };
    if (!codeMatches(code, row.code_hash)) {
      return { kind: 'wrong', left: await repo.countWrongCode(client, row.code_id) };
    }
    await repo.useCode(client, row.code_id);
    return { kind: 'ok', value: await onMatch(client, row) };
  });
}

// --- Sessions ---------------------------------------------------------------------------------

async function profileOf(customer: CustomerRow): Promise<CustomerProfile> {
  return {
    customerId: customer.customer_id,
    firstName: customer.first_name,
    lastName: customer.last_name,
    email: customer.email,
    mobile: customer.mobile,
    twoFactorEnabled: customer.two_factor_enabled,
    pendingEmail: await repo.findPendingEmail(customer.customer_id),
    lastLoginAt: customer.last_login_at,
    createdAt: customer.created_at,
  };
}

async function issueSession(
  db: Queryable,
  customer: CustomerRow,
  context: RequestContext,
  familyId: string = randomUUID(),
): Promise<Session> {
  const refresh = newRefreshToken();
  const refreshExpiresAt = await repo.insertRefreshToken(db, {
    customerId: customer.customer_id,
    tokenHash: refresh.hash,
    familyId,
    userAgent: context.userAgent,
    daysValid: REFRESH_DAYS,
  });
  return {
    accessToken: signAccessToken(customer.customer_id, customer.session_version),
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_SECONDS,
    customer: await profileOf(customer),
    refreshToken: refresh.token,
    refreshExpiresAt,
  };
}

async function completeSignIn(
  db: Queryable,
  customerId: number,
  context: RequestContext,
): Promise<Session> {
  const customer = await repo.recordSuccessfulSignIn(db, customerId);
  await repo.deleteOldRefreshTokens(db, customerId);
  return issueSession(db, customer, context);
}

// --- Register and confirm the email -----------------------------------------------------------

/**
 * Creates an unverified account and emails a code. If the email already has
 * an account, nothing is created, the reply is exactly the same, and the
 * email tells the owner to sign in instead.
 */
export async function register(
  input: RegisterInput,
): Promise<{ email: string; message: string }> {
  const reply = { email: input.email, message: CHECK_EMAIL };
  // Hashed whether or not it's needed, so both paths take about as long.
  const passwordHash = await hashPassword(input.password);
  // Both paths count as a code sent, so a resend right after behaves the same either way.
  const canSend = sendThrottle.take(`verify_email:${input.email}`) === 0;

  const alreadyRegistered = async (customer: CustomerRow | null) => {
    if (sendThrottle.take(`already_registered:${input.email}`) === 0) {
      sendEmailInBackground(
        customerAlreadyRegistered({
          to: input.email,
          name: customer?.first_name ?? input.firstName,
        }),
        'customer-already-registered',
      );
    }
    return reply;
  };

  const existing = await repo.findCustomerByEmail(input.email);
  if (existing) return alreadyRegistered(existing);

  try {
    const code = await withTransaction(async (client) => {
      const customer = await repo.insertCustomer(client, {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        mobile: input.mobile,
        passwordHash,
      });
      return newCode(client, customer.customer_id, 'verify_email');
    });
    if (canSend) {
      sendEmailInBackground(
        customerSignUpCode({ to: input.email, name: input.firstName, code }),
        'customer-sign-up-code',
      );
    }
    return reply;
  } catch (error) {
    // Someone registered the same email a moment earlier.
    if (constraintOf(error) === 'customer_email_key') return alreadyRegistered(null);
    throw error;
  }
}

/** The code from the sign-up email. Confirms the email and signs the customer in. */
export async function verifyEmail(
  { email, code }: VerifyEmailInput,
  context: RequestContext,
): Promise<Session> {
  const customer = await repo.findCustomerByEmail(email);
  if (!customer || customer.email_verified_at) throw genericCodeError();
  assertNotLocked(customer);

  const outcome = await useCodeThen(customer.customer_id, 'verify_email', code, async (db) => {
    await repo.markEmailVerified(db, customer.customer_id);
    return completeSignIn(db, customer.customer_id, context);
  });
  if (outcome.kind !== 'ok') throw genericCodeError();
  return outcome.value;
}

/**
 * A new code: { email } for sign-up, { pendingToken } for a login code.
 * At most one a minute and 5 an hour per address (429 otherwise). For an
 * email, the reply is the same whether or not it needs a code.
 */
export async function resendCode(input: ResendCodeInput): Promise<{ message: string }> {
  if ('pendingToken' in input) {
    const customer = await customerForLoginCode(input.pendingToken);
    const wait = sendThrottle.take(`login_2fa:${customer.email}`);
    if (wait > 0) throw waitBeforeResending(wait);
    const code = await newCode(pool, customer.customer_id, 'login_2fa');
    sendEmailInBackground(
      customerLoginCode({ to: customer.email, name: customer.first_name, code }),
      'customer-login-code',
    );
    return { message: 'We have emailed you a new code.' };
  }

  const wait = sendThrottle.take(`verify_email:${input.email}`);
  if (wait > 0) throw waitBeforeResending(wait);
  const customer = await repo.findCustomerByEmail(input.email);
  if (customer && !customer.email_verified_at) {
    const code = await newCode(pool, customer.customer_id, 'verify_email');
    sendEmailInBackground(
      customerSignUpCode({ to: customer.email, name: customer.first_name, code }),
      'customer-sign-up-code',
    );
  }
  return { message: 'If this email address needs a code, a new one is on its way.' };
}

// --- Sign in ----------------------------------------------------------------------------------

export async function signIn(
  { email, password }: LoginInput,
  context: RequestContext,
): Promise<Session | LoginCodeStep> {
  const customer = await repo.findCustomerByEmail(email);
  if (!customer) {
    await verifyPassword(password, await timingDummy());
    throw wrongCredentials();
  }
  assertNotLocked(customer);
  if (!(await verifyPassword(password, customer.password_hash))) {
    throw await failedAttempt(customer, wrongCredentials());
  }
  // Only after the right password, so this never reveals an account to a stranger.
  if (!customer.email_verified_at) throw notVerified();

  if (customer.two_factor_enabled) {
    // A second sign-in within a minute reuses the code already sent (it lasts 10 minutes).
    if (sendThrottle.take(`login_2fa:${customer.email}`) === 0) {
      const code = await newCode(pool, customer.customer_id, 'login_2fa');
      sendEmailInBackground(
        customerLoginCode({ to: customer.email, name: customer.first_name, code }),
        'customer-login-code',
      );
    }
    const { token, expiresIn } = signSignInToken(customer.customer_id, customer.session_version);
    return { twoFactorRequired: true, pendingToken: token, expiresIn };
  }
  return withTransaction((client) => completeSignIn(client, customer.customer_id, context));
}

async function customerForLoginCode(pendingToken: string): Promise<CustomerRow> {
  const claims = readSignInToken(pendingToken);
  const customer = await repo.findCustomerById(claims.customerId);
  if (
    !customer ||
    !customer.is_active ||
    customer.deleted_at ||
    customer.session_version !== claims.sessionVersion ||
    !customer.two_factor_enabled
  ) {
    throw signInExpired();
  }
  assertNotLocked(customer);
  return customer;
}

/** The second step when login codes are on. Wrong codes count towards the account lock too. */
export async function verifyLoginCode(
  { pendingToken, code }: LoginVerifyInput,
  context: RequestContext,
): Promise<Session> {
  const customer = await customerForLoginCode(pendingToken);
  const outcome = await useCodeThen(customer.customer_id, 'login_2fa', code, (db) =>
    completeSignIn(db, customer.customer_id, context),
  );
  if (outcome.kind === 'ok') return outcome.value;
  if (outcome.kind === 'none') {
    throw codeError('This code has expired or can no longer be used. Please ask for a new one.');
  }
  throw await failedAttempt(
    customer,
    outcome.left > 0
      ? wrongCodeWithTriesLeft(outcome.left)
      : codeError('That code is incorrect and can no longer be used. Please ask for a new one.'),
  );
}

type RefreshOutcome = { kind: 'ok'; session: Session } | { kind: 'ended' } | { kind: 'stolen' };

/**
 * Swaps a refresh token for a new pair; the old one stops working. If an old,
 * already-replaced token comes back later, someone has a copy of it, so every
 * session the customer has is ended.
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
        await repo.endAllSessions(client, token.customer_id, 'reuse_detected');
        return { kind: 'stolen' };
      }
      if (!(await repo.familyIsActive(client, token.family_id))) return { kind: 'ended' };
    }

    const customer = await repo.findCustomerById(token.customer_id, client);
    if (!customer || !customer.is_active || customer.deleted_at) {
      await repo.revokeFamily(client, token.family_id, 'account_deactivated');
      return { kind: 'ended' };
    }
    if (!token.revoked) await repo.revokeRefreshToken(client, token.token_id, 'rotated');
    return { kind: 'ok', session: await issueSession(client, customer, context, token.family_id) };
  });

  if (outcome.kind === 'stolen') {
    throw errors.unauthorized(
      'For your safety, you have been signed out on all devices. Please sign in again.',
    );
  }
  if (outcome.kind === 'ended') throw sessionEnded();
  return outcome.session;
}

/** Signs out this device. Always succeeds, even if the session had already ended. */
export async function signOut(refreshToken: string | undefined): Promise<void> {
  if (refreshToken) await repo.revokeFamilyByTokenHash(hashRefreshToken(refreshToken));
}

// --- Forgotten password -----------------------------------------------------------------------

/** Emails a reset code. The same reply whether or not the email has an account. */
export async function forgotPassword({ email }: ForgotPasswordInput): Promise<{ message: string }> {
  if (sendThrottle.take(`reset_password:${email}`) === 0) {
    const customer = await repo.findCustomerByEmail(email);
    if (customer) {
      const code = await newCode(pool, customer.customer_id, 'reset_password');
      sendEmailInBackground(
        customerPasswordResetCode({ to: customer.email, name: customer.first_name, code }),
        'customer-password-reset-code',
      );
    }
  }
  return { message: 'If an account uses this email address, we have emailed it a code.' };
}

/**
 * Sets a new password with the emailed code, and signs out every device.
 * The customer then signs in with the new password.
 */
export async function resetPassword({
  email,
  code,
  newPassword,
}: ResetPasswordInput): Promise<{ passwordReset: true }> {
  const passwordHash = await hashPassword(newPassword);
  const customer = await repo.findCustomerByEmail(email);
  if (!customer) throw genericCodeError();

  const outcome = await useCodeThen(customer.customer_id, 'reset_password', code, async (db) => {
    await repo.updateCustomer(db, customer.customer_id, { password_hash: passwordHash });
    // The code arrived by email, so the address is confirmed too.
    await repo.markEmailVerified(db, customer.customer_id);
    await repo.clearLock(db, customer.customer_id);
    await repo.endAllSessions(db, customer.customer_id, 'password_reset');
  });
  if (outcome.kind !== 'ok') throw genericCodeError();

  sendEmailInBackground(
    customerPasswordChanged({ to: customer.email, name: customer.first_name }),
    'customer-password-changed',
  );
  return { passwordReset: true };
}

// --- The signed-in customer (/me) ---------------------------------------------------------------

async function signedInCustomer(customerId: number): Promise<CustomerRow> {
  const customer = await repo.findCustomerById(customerId);
  if (!customer || !customer.is_active || customer.deleted_at) throw sessionEnded();
  return customer;
}

export async function getProfile(customerId: number): Promise<CustomerProfile> {
  return profileOf(await signedInCustomer(customerId));
}

/**
 * Names and mobile change straight away. A new email address gets a code
 * and only takes effect once it is entered (verifyNewEmail).
 */
export async function updateProfile(
  customerId: number,
  input: UpdateProfileInput,
): Promise<CustomerProfile> {
  const customer = await signedInCustomer(customerId);
  const changes: repo.CustomerChanges = {};
  if (input.firstName !== undefined && input.firstName !== customer.first_name) {
    changes.first_name = input.firstName;
  }
  if (input.lastName !== undefined && input.lastName !== customer.last_name) {
    changes.last_name = input.lastName;
  }
  if (input.mobile !== undefined && input.mobile !== customer.mobile) changes.mobile = input.mobile;

  if (input.email !== undefined && input.email !== customer.email) {
    const wait = sendThrottle.take(`change_email:${customerId}`);
    if (wait > 0) throw waitBeforeResending(wait);
    // A code is saved either way, so the reply never shows whether the address is taken.
    const code = await newCode(pool, customerId, 'change_email', input.email);
    if (await repo.emailInUse(input.email)) {
      sendEmailInBackground(
        customerEmailAlreadyUsed({ to: input.email, name: 'there' }),
        'customer-email-already-used',
      );
    } else {
      sendEmailInBackground(
        customerEmailChangeCode({ to: input.email, name: customer.first_name, code }),
        'customer-email-change-code',
      );
    }
  }

  const updated = await repo.updateCustomer(pool, customerId, changes);
  return profileOf(updated);
}

/** The code sent to the new address. Only then does the email change. */
export async function verifyNewEmail(
  customerId: number,
  { code }: VerifyNewEmailInput,
): Promise<CustomerProfile> {
  await signedInCustomer(customerId);
  let outcome: CodeCheck<CustomerRow>;
  try {
    outcome = await useCodeThen(customerId, 'change_email', code, (db, row) =>
      repo.updateCustomer(db, customerId, { email: row.new_email! }),
    );
  } catch (error) {
    if (constraintOf(error) === 'customer_email_key') throw genericCodeError();
    throw error;
  }
  if (outcome.kind === 'ok') return profileOf(outcome.value);
  if (outcome.kind === 'wrong' && outcome.left > 0) throw wrongCodeWithTriesLeft(outcome.left);
  throw genericCodeError();
}

/** Needs the current password. Signs out every other device; this one gets a fresh session. */
export async function changePassword(
  customerId: number,
  { currentPassword, newPassword }: ChangePasswordInput,
  context: RequestContext,
): Promise<Session> {
  const customer = await signedInCustomer(customerId);
  await checkPassword(customer, currentPassword, 'currentPassword');
  if (newPassword === currentPassword) {
    throw errors.validation([
      {
        field: 'newPassword',
        message: 'Please choose a new password that is different from your current one.',
      },
    ]);
  }
  const passwordHash = await hashPassword(newPassword);
  const session = await withTransaction(async (client) => {
    await repo.updateCustomer(client, customerId, { password_hash: passwordHash });
    const updated = await repo.endAllSessions(client, customerId, 'password_changed');
    return issueSession(client, updated, context);
  });
  sendEmailInBackground(
    customerPasswordChanged({ to: customer.email, name: customer.first_name }),
    'customer-password-changed',
  );
  return session;
}

/** Emailed login codes on or off. Needs the password. */
export async function setTwoFactor(
  customerId: number,
  { enabled, password }: TwoFactorInput,
): Promise<CustomerProfile> {
  const customer = await signedInCustomer(customerId);
  await checkPassword(customer, password, 'password');
  const updated = await repo.updateCustomer(pool, customerId, {
    two_factor_enabled: enabled,
  });
  return profileOf(updated);
}

/**
 * Deletes the account (POPIA): personal details are removed, every session
 * ends, and orders stay on record. Needs the password.
 */
export async function deleteAccount(
  customerId: number,
  { password }: DeleteAccountInput,
): Promise<void> {
  const customer = await signedInCustomer(customerId);
  await checkPassword(customer, password, 'password');
  await withTransaction(async (client) => {
    await repo.endAllSessions(client, customerId, 'account_deactivated');
    await repo.anonymiseCustomer(client, customerId);
  });
  sendEmailInBackground(
    customerAccountDeleted({ to: customer.email, name: customer.first_name }),
    'customer-account-deleted',
  );
}
