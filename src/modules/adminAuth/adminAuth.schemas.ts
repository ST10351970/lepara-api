import { z } from 'zod';
import { password, passwordsMatch, requiredText } from '../../schemas/common';
import { BACKUP_CODE_PATTERN, normaliseBackupCode } from './adminAuth.codes';

/** What each admin sign-in endpoint accepts. Messages appear on the website's forms. */

export const loginSchema = z.object({
  username: requiredText('Please enter your username.')
    .trim()
    .toLowerCase()
    .min(1, 'Please enter your username.')
    .max(50, 'That username is too long.'),
  // No strength rules here: those apply when a password is chosen, not when it is typed.
  password: requiredText('Please enter your password.')
    .min(1, 'Please enter your password.')
    .max(128, 'That password is too long.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

const signInToken = requiredText('Your sign-in has expired. Please start again.')
  .min(1, 'Your sign-in has expired. Please start again.')
  .max(2000, 'Your sign-in has expired. Please start again.');

export const signInTokenSchema = z.object({ pendingToken: signInToken });
export type SignInTokenInput = z.infer<typeof signInTokenSchema>;

const APP_CODE_MESSAGE = 'Please enter the 6-digit code from your authenticator app.';

/** During set-up: only a code from the app proves the QR code was scanned. */
export const confirmTwoFactorSchema = z.object({
  pendingToken: signInToken,
  code: requiredText(APP_CODE_MESSAGE)
    .transform((value) => value.replace(/[\s-]/g, ''))
    .refine((value) => /^\d{6}$/.test(value), APP_CODE_MESSAGE),
});
export type ConfirmTwoFactorInput = z.infer<typeof confirmTwoFactorSchema>;

const SIGN_IN_CODE_MESSAGE =
  'Please enter the 6-digit code from your authenticator app, or one of your backup codes.';

/** At sign-in: a 6-digit app code or a 10-character backup code. */
export const verifyTwoFactorSchema = z.object({
  pendingToken: signInToken,
  code: requiredText(SIGN_IN_CODE_MESSAGE)
    .transform(normaliseBackupCode)
    .refine(
      (value) => /^\d{6}$/.test(value) || BACKUP_CODE_PATTERN.test(value),
      SIGN_IN_CODE_MESSAGE,
    ),
});
export type VerifyTwoFactorInput = z.infer<typeof verifyTwoFactorSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: requiredText('Please enter your current password.')
      .min(1, 'Please enter your current password.')
      .max(128, 'That password is too long.'),
    newPassword: password,
    confirmPassword: requiredText('Please type your new password again.'),
  })
  .superRefine(passwordsMatch('newPassword', 'confirmPassword'));
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
