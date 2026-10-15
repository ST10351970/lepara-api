import bcrypt from 'bcryptjs';
import { env } from '../config/env';

/**
 * Password hashing with bcrypt, in one place.
 *
 * Cost 12 makes each hash take a noticeable fraction of a second, which
 * slows down anyone trying to guess passwords from a stolen database copy.
 * Automated tests use cost 4 so they run quickly. Each hash records its own
 * cost, so checking a password works whichever cost made the hash.
 */
export const BCRYPT_COST = env.NODE_ENV === 'test' ? 4 : 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
