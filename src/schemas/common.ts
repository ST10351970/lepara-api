import { z } from 'zod';
import { COMMON_PASSWORDS } from '../data/commonPasswords';
import { isRealIsoDate } from '../utils/dates';
import { parseRandsToCents } from '../utils/money';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../utils/pagination';

/**
 * Reusable validation rules. Every message is written for the person filling
 * in the form, because the app shows it directly under the field.
 * Later steps build each endpoint's schema from these pieces.
 */

/** A string field with its own "missing" message instead of Zod's technical one. */
export function requiredText(missingMessage: string) {
  return z.string({
    error: (issue) =>
      issue.input === undefined || issue.input === null ? missingMessage : 'Please enter text.',
  });
}

// --- People ---------------------------------------------------------------

const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' ’-]*$/u;

/** First name, last name or full name: letters, spaces, hyphens, apostrophes. */
export function personName(label = 'your name', max = 60) {
  return requiredText(`Please enter ${label}.`)
    .trim()
    .min(2, `Please enter ${label} (at least 2 characters).`)
    .max(max, `Please keep ${label} under ${max} characters.`)
    .regex(NAME_PATTERN, 'Please enter your name using letters only.');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

export const emailAddress = requiredText('Please enter your email address.')
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .regex(EMAIL_PATTERN, 'Please enter a valid email, for example name@example.com.');

const PHONE_MESSAGE = 'Please enter a South African number, for example 071 234 5678.';

/** Accepts 071 234 5678, 0712345678, +27 71 234 5678, 27712345678. Stores +27712345678. */
export const saPhoneNumber = requiredText('Please enter your phone number.').transform(
  (value, ctx) => {
    const digits = value.trim().replace(/[\s()-]/g, '');
    if (/^0[1-8]\d{8}$/.test(digits)) return `+27${digits.slice(1)}`;
    if (/^\+27[1-8]\d{8}$/.test(digits)) return digits;
    if (/^27[1-8]\d{8}$/.test(digits)) return `+${digits}`;
    ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
    return z.NEVER;
  },
);

/** The last 4 digits of a phone number, used with a reference number for tracking. */
export const phoneLast4 = requiredText('Please enter the last 4 digits of your phone number.')
  .trim()
  .regex(/^\d{4}$/, 'Please enter the last 4 digits of your phone number.');

// --- Passwords and codes --------------------------------------------------

export const password = requiredText('Please enter a password.')
  .min(8, 'Your password needs at least 8 characters.')
  .max(64, 'Your password can be at most 64 characters.')
  .regex(/[A-Za-z]/, 'Your password needs at least one letter.')
  .regex(/\d/, 'Your password needs at least one number.')
  .refine(
    (value) => !COMMON_PASSWORDS.has(value.toLowerCase()),
    'That password is too common. Please choose another.',
  );

/** Adds a "passwords don't match" check to an object with a password and its confirmation. */
export function passwordsMatch<T extends Record<string, unknown>>(
  passwordKey: keyof T & string,
  confirmKey: keyof T & string,
) {
  return (data: T, ctx: z.RefinementCtx) => {
    if (data[passwordKey] !== data[confirmKey]) {
      ctx.addIssue({ code: 'custom', path: [confirmKey], message: "Your passwords don't match." });
    }
  };
}

export const sixDigitCode = requiredText('Please enter the 6-digit code.')
  .trim()
  .regex(/^\d{6}$/, 'Please enter the 6-digit code from your email.');

// --- Free text ------------------------------------------------------------

export function description(min = 10, max = 1000) {
  return requiredText('Please add a description.')
    .trim()
    .min(min, `Please tell us a little more (at least ${min} characters).`)
    .max(max, `Please keep this under ${max} characters.`);
}

export function shortText(missingMessage: string, min: number, max: number) {
  return requiredText(missingMessage)
    .trim()
    .min(min, missingMessage)
    .max(max, `Please keep this under ${max} characters.`);
}

export const availability = shortText('Please say when you are available.', 3, 200);

export const streetAddress = shortText('Please enter your street address.', 3, 120);
export const city = shortText('Please enter your city or town.', 2, 60);

export const postalCode = requiredText('Please enter your postal code.')
  .trim()
  .regex(/^\d{4}$/, 'Postal codes have 4 digits.');

// --- Numbers and money ----------------------------------------------------

const AMOUNT_MESSAGE = 'Please enter an amount in rands, for example 250 or 250.50.';

/** An amount in rands from a form ("250.50" or 250.5), returned as cents (25050). */
export function randsToCents(maxRands = 1_000_000) {
  return z.union([z.string(), z.number()], { error: AMOUNT_MESSAGE }).transform((value, ctx) => {
    const cents = parseRandsToCents(value);
    if (cents === null) {
      ctx.addIssue({ code: 'custom', message: AMOUNT_MESSAGE });
      return z.NEVER;
    }
    if (cents > maxRands * 100) {
      ctx.addIssue({
        code: 'custom',
        message: `Please enter an amount up to R${maxRands.toLocaleString('en-ZA')}.`,
      });
      return z.NEVER;
    }
    return cents;
  });
}

/** A whole number in a range, e.g. quantity(1, 10) for an order line. */
export function quantity(min: number, max: number) {
  const message = `Please choose a quantity from ${min} to ${max}.`;
  return z
    .number({ error: 'Please enter a whole number.' })
    .int('Please enter a whole number.')
    .min(min, message)
    .max(max, message);
}

// --- Choices, consent, dates, IDs -----------------------------------------

/** One value from a fixed list (category, task, size, payment method, status). */
export function oneOf<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.enum(values, { error: 'Please choose one of the options.' });
}

export const consentGiven = z.literal(true, {
  error: 'Please tick the box to agree before sending.',
});

export const isoDate = requiredText('Please enter a date.')
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please enter the date as YYYY-MM-DD.')
  .refine(isRealIsoDate, 'Please enter a real date.');

/** :id in a URL. Anything that is not a positive whole number gets a 400, not a database error. */
export const idParam = z.object({
  id: z.coerce
    .number({ error: "We couldn't find that item." })
    .int("We couldn't find that item.")
    .positive("We couldn't find that item.")
    .max(2_147_483_647, "We couldn't find that item."),
});

// --- Lists ----------------------------------------------------------------

/** ?page=&pageSize= : invalid values fall back to defaults instead of failing. */
export const pagination = z.object({
  page: z.coerce
    .number()
    .int()
    .catch(1)
    .transform((page) => Math.min(Math.max(page, 1), 10_000)),
  pageSize: z.coerce
    .number()
    .int()
    .catch(DEFAULT_PAGE_SIZE)
    .transform((size) => Math.min(Math.max(size, 1), MAX_PAGE_SIZE)),
});

/** ?search= : trimmed and cut to 100 characters; empty becomes undefined. */
export const searchText = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => {
    const trimmed = value?.trim().slice(0, 100);
    return trimmed ? trimmed : undefined;
  });
