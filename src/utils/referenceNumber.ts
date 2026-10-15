import { randomInt } from 'node:crypto';
import { constraintOf, isPgError } from './pgErrors';

/**
 * Reference numbers that community members use to track a submission,
 * for example REQ-7K3P9X. They are random, never sequential, so nobody can
 * guess someone else's. The alphabet leaves out characters people confuse
 * when reading or typing: 0 and O, 1 and I.
 */

export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const REFERENCE_LENGTH = 6;

export const ReferencePrefix = {
  assistanceRequest: 'REQ',
  volunteerApplication: 'VOL',
  donationPledge: 'PLG',
} as const;

export type ReferencePrefix = (typeof ReferencePrefix)[keyof typeof ReferencePrefix];

export const REFERENCE_PATTERN = new RegExp(
  `^(REQ|VOL|PLG)-[${REFERENCE_ALPHABET}]{${REFERENCE_LENGTH}}$`,
);

export function generateReference(prefix: ReferencePrefix): string {
  let code = '';
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    code += REFERENCE_ALPHABET.charAt(randomInt(REFERENCE_ALPHABET.length));
  }
  return `${prefix}-${code}`;
}

/** Accepts what people type: lower case, spaces, a missing dash. */
export function normaliseReference(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  return compact.length > 3 ? `${compact.slice(0, 3)}-${compact.slice(3)}` : compact;
}

/**
 * Runs an insert with a fresh reference number, trying again with a new one
 * if the database reports a clash on a reference_number unique constraint.
 * A clash is very rare (about 1 in a billion per pair), but handled anyway.
 */
export async function withUniqueReference<T>(
  prefix: ReferencePrefix,
  insert: (reference: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await insert(generateReference(prefix));
    } catch (error) {
      const clash =
        isPgError(error) &&
        error.code === '23505' &&
        (constraintOf(error) ?? '').includes('reference_number');
      if (!clash || attempt >= maxAttempts) throw error;
    }
  }
}
