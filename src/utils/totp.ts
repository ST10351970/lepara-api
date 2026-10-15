import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticator-app codes (Google Authenticator, Microsoft Authenticator,
 * Authy). These are the open standards every authenticator app follows:
 *   RFC 4226 (HOTP): a 6-digit code from a shared secret and a counter.
 *   RFC 6238 (TOTP): the counter is the current 30-second time step.
 *   RFC 4648: the secret is shown to the app in Base32.
 * tests/unit/totp.test.ts checks this code against the RFCs' own test values.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next code too, in case the phone's clock is slightly off. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1; // keep only the bits not yet written
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error('The secret is not valid Base32.');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

/** A new random secret: 20 bytes (160 bits, as RFC 4226 recommends), 32 Base32 characters. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226: the code for one counter value. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 30-second time step for a moment in time (milliseconds since 1970). */
export function totpStep(timeMs = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 6238: the code an authenticator app shows for a time step. */
export function totpCode(secret: string, step = totpStep(), digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secret), step, digits);
}

/**
 * Checks a 6-digit code against the previous, current and next time step.
 * Returns the step that matched (so the caller can refuse it next time), or
 * null. Every candidate is compared in constant time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  { timeMs = Date.now(), window = TOTP_WINDOW }: { timeMs?: number; window?: number } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = totpStep(timeMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), given)) matched = step;
  }
  return matched;
}

/**
 * The link inside the QR code. Scanning it adds the account to the app.
 * Format: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export function otpauthUrl({
  issuer,
  account,
  secret,
}: {
  issuer: string;
  account: string;
  secret: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ];
  return `otpauth://totp/${label}?${params.join('&')}`;
}

/** The secret in groups of 4, for typing into the app when the QR code can't be scanned. */
export function formatSecretForTyping(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}
