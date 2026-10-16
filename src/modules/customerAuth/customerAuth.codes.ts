import { randomInt, timingSafeEqual } from 'node:crypto';
import { keyedHash } from '../../utils/crypto';

/**
 * The 6-digit codes emailed to customers (verify email, login, password
 * reset, email change).
 *  - Made with crypto.randomInt, so they can't be predicted.
 *  - Only a keyed hash is stored: a copy of the database alone can't be used
 *    to try all million codes.
 *  - Each works for 10 minutes and allows 5 tries, then stops working.
 *  - A new code cancels the older ones for the same purpose.
 */

export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;

export type CodePurpose = 'verify_email' | 'login_2fa' | 'reset_password' | 'change_email';

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(code: string): string {
  return keyedHash(`customer-code:${code}`);
}

/** Compares a typed code with a stored hash in constant time. */
export function codeMatches(code: string, storedHash: string): boolean {
  const typed = Buffer.from(hashCode(code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return typed.length === stored.length && timingSafeEqual(typed, stored);
}

// --- How often codes can be sent ------------------------------------------------------------

export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Remembers when codes were sent to each email address, in memory (fine for
 * one API server). It applies whether or not the address has an account, so
 * the replies never give that away. At most one code a minute and 5 an hour.
 */
export class SendThrottle {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Records a send and returns 0, or returns how many seconds to wait. */
  take(key: string): number {
    const now = this.now();
    const recent = (this.sent.get(key) ?? []).filter((time) => now - time < HOUR_MS);
    const last = recent.at(-1);
    if (last !== undefined && now - last < RESEND_COOLDOWN_SECONDS * 1000) {
      return Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - (now - last)) / 1000);
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      return Math.ceil((HOUR_MS - (now - recent[0]!)) / 1000);
    }
    recent.push(now);
    this.sent.set(key, recent);
    if (this.sent.size > 10_000) this.forgetOld(now);
    return 0;
  }

  private forgetOld(now: number): void {
    for (const [key, times] of this.sent) {
      if (times.every((time) => now - time >= HOUR_MS)) this.sent.delete(key);
    }
  }
}

export const sendThrottle = new SendThrottle();
