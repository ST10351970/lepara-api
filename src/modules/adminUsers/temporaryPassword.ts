import { randomCode } from '../../utils/crypto';

/**
 * A temporary password for a new admin, or one who forgot theirs, such as
 * "Hq7x-mR4t-9kPz". Twelve random characters (about 69 bits), without
 * look-alikes (0/O, 1/l/I), so it is easy to read out or copy. It always
 * passes the password rules, and the admin must change it at first sign-in.
 */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateTemporaryPassword(): string {
  for (;;) {
    const raw = randomCode(12, ALPHABET);
    if (/[A-Za-z]/.test(raw) && /\d/.test(raw)) {
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    }
  }
}
