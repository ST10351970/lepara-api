import { z } from 'zod';
import {
  emailAddress,
  password,
  passwordsMatch,
  personName,
  requiredText,
  saPhoneNumber,
  sixDigitCode,
} from '../../schemas/common';

/** What the customer account endpoints accept. Messages appear on the app's screens. */

/** Typed passwords: no strength rules here; those apply when a password is chosen. */
const typedPassword = (missing: string) =>
  requiredText(missing).min(1, missing).max(128, 'That password is too long.');

const code = sixDigitCode;

/** The customer table holds addresses of up to 254 characters, like the shared rule. */
const email = emailAddress;

/** POST /auth/register */
export const registerSchema = z
  .object({
    firstName: personName('your first name'),
    lastName: personName('your last name'),
    email,
    mobile: saPhoneNumber,
    password,
    confirmPassword: requiredText('Please type your password again.'),
    acceptTerms: z.literal(true, {
      error: 'Please accept the terms and privacy policy to create an account.',
    }),
  })
  .superRefine(passwordsMatch('password', 'confirmPassword'));
export type RegisterInput = z.infer<typeof registerSchema>;

/** POST /auth/verify-email */
export const verifyEmailSchema = z.object({ email, code });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

const pendingToken = requiredText('Your sign-in has expired. Please sign in again.')
  .min(1, 'Your sign-in has expired. Please sign in again.')
  .max(2000, 'Your sign-in has expired. Please sign in again.');

/**
 * POST /auth/resend-code: { email } for a new sign-up code, or
 * { pendingToken } for a new login code.
 */
export const resendCodeSchema = z.union(
  [z.object({ pendingToken }), z.object({ email })],
  { error: 'Please enter your email address.' },
);
export type ResendCodeInput = z.infer<typeof resendCodeSchema>;

/** POST /auth/login */
export const loginSchema = z.object({
  email,
  password: typedPassword('Please enter your password.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** POST /auth/login/verify */
export const loginVerifySchema = z.object({ pendingToken, code });
export type LoginVerifyInput = z.infer<typeof loginVerifySchema>;

/** POST /auth/forgot-password */
export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** POST /auth/reset-password */
export const resetPasswordSchema = z
  .object({
    email,
    code,
    newPassword: password,
    confirmPassword: requiredText('Please type your new password again.'),
  })
  .superRefine(passwordsMatch('newPassword', 'confirmPassword'));
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// --- The signed-in customer (/me) ----------------------------------------------------------

/**
 * PATCH /me. A new email only takes effect once its own code is entered
 * (POST /me/email/verify).
 */
export const updateProfileSchema = z
  .object({
    firstName: personName('your first name').optional(),
    lastName: personName('your last name').optional(),
    mobile: saPhoneNumber.optional(),
    email: email.optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Please change at least one detail.',
  );
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** POST /me/email/verify */
export const verifyNewEmailSchema = z.object({ code });
export type VerifyNewEmailInput = z.infer<typeof verifyNewEmailSchema>;

/** PATCH /me/password */
export const changePasswordSchema = z
  .object({
    currentPassword: typedPassword('Please enter your current password.'),
    newPassword: password,
    confirmPassword: requiredText('Please type your new password again.'),
  })
  .superRefine(passwordsMatch('newPassword', 'confirmPassword'));
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** PATCH /me/two-factor: emailed login codes on or off. */
export const twoFactorSchema = z.object({
  enabled: z.boolean({ error: 'Please choose on or off.' }),
  password: typedPassword('Please enter your password to change this setting.'),
});
export type TwoFactorInput = z.infer<typeof twoFactorSchema>;

/** DELETE /me */
export const deleteAccountSchema = z.object({
  password: typedPassword('Please enter your password to delete your account.'),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
