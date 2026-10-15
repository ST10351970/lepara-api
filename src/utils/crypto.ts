import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';
import { env } from '../config/env';

/**
 * Small, well-known building blocks from Node's own crypto library.
 * Nothing here invents its own cryptography.
 */

const ENCRYPTION_FORMAT = 'v1';
const AUTH_TAG_BYTES = 16;

function encryptionKey(): Buffer {
  return Buffer.from(env.TOTP_ENCRYPTION_KEY, 'hex');
}

/**
 * Encrypts a secret with AES-256-GCM, which also detects tampering.
 * Result: "v1.<iv>.<tag>.<ciphertext>" in base64url. A new random IV is used
 * every time, so the same secret never encrypts to the same text twice.
 */
export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_FORMAT, iv, tag, ciphertext].map(asText).join('.');
}

/** Reverses encryptSecret. Throws if the value was changed or the key is wrong. */
export function decryptSecret(payload: string, key: Buffer = encryptionKey()): string {
  const [format, iv, tag, ciphertext, extra] = payload.split('.');
  if (format !== ENCRYPTION_FORMAT || !iv || !tag || ciphertext === undefined || extra) {
    throw new Error('This encrypted value is not in a format the API recognises.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function asText(part: string | Buffer): string {
  return typeof part === 'string' ? part : part.toString('base64url');
}

/** SHA-256 as 64 hex characters. For long random tokens, where guessing is impossible. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let codeHashKey: Buffer | undefined;

/**
 * HMAC-SHA-256 with a key that only the server has, as 64 hex characters.
 * Used for short codes (backup codes): a copy of the database alone is not
 * enough to try every possible code. The key is derived from
 * TOTP_ENCRYPTION_KEY, so there is no extra setting to manage.
 */
export function keyedHash(value: string): string {
  codeHashKey ??= Buffer.from(
    hkdfSync('sha256', encryptionKey(), Buffer.alloc(0), 'lepara one-time codes', 32),
  );
  return createHmac('sha256', codeHashKey).update(value, 'utf8').digest('hex');
}

/** A random token for a URL or cookie: 32 bytes (256 bits) as base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Random characters chosen evenly from an alphabet. */
export function randomCode(length: number, alphabet: string): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}
