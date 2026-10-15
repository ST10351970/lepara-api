import { keyedHash, randomCode } from '../../utils/crypto';
import { REFERENCE_ALPHABET } from '../../utils/referenceNumber';

/**
 * Backup codes: 10 one-time codes for when an admin's phone is lost.
 * Each is 10 characters from the same easy-to-read alphabet as reference
 * numbers (no 0, O, 1 or I), shown as ABCDE-FGHJK. Only a keyed hash of each
 * code is stored, and each works once.
 */

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

export const BACKUP_CODE_PATTERN = new RegExp(`^[${REFERENCE_ALPHABET}]{${BACKUP_CODE_LENGTH}}$`);

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomCode(BACKUP_CODE_LENGTH, REFERENCE_ALPHABET));
  return [...codes].map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
}

/** "abcde fghjk", "ABCDE-FGHJK" and "ABCDEFGHJK" are all the same code. */
export function normaliseBackupCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function hashBackupCode(code: string): string {
  return keyedHash(normaliseBackupCode(code));
}
