import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_CODE_PATTERN,
  generateBackupCodes,
  hashBackupCode,
  normaliseBackupCode,
} from '../../src/modules/adminAuth/adminAuth.codes';
import {
  decryptSecret,
  encryptSecret,
  keyedHash,
  randomCode,
  randomToken,
  sha256Hex,
} from '../../src/utils/crypto';

describe('encryptSecret and decryptSecret (AES-256-GCM)', () => {
  it('gets the original back', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(encrypted).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(encrypted)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never gives the same output twice for the same secret', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('notices if the stored value was changed', () => {
    const [format, iv, tag, ciphertext] = encryptSecret('JBSWY3DPEHPK3PXP').split('.');
    const flipped = Buffer.from(ciphertext!, 'base64url');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 1, 0);
    const tampered = [format, iv, tag, flipped.toString('base64url')].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('cannot be read with a different key', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('refuses values that are not in its format', () => {
    expect(() => decryptSecret('JBSWY3DPEHPK3PXP')).toThrow(/format/);
    expect(() => decryptSecret('v2.a.b.c')).toThrow(/format/);
  });
});

describe('hashing', () => {
  it('computes SHA-256 like everyone else', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('keyed hashes are repeatable, 64 characters, and not plain SHA-256', () => {
    expect(keyedHash('ABCDEFGHJK')).toBe(keyedHash('ABCDEFGHJK'));
    expect(keyedHash('ABCDEFGHJK')).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedHash('ABCDEFGHJK')).not.toBe(sha256Hex('ABCDEFGHJK'));
  });

  it('makes unguessable random tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('picks random codes from the given alphabet only', () => {
    expect(randomCode(50, 'AB')).toMatch(/^[AB]{50}$/);
  });
});

describe('backup codes', () => {
  it('gives 10 different codes that are easy to read', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
      expect(normaliseBackupCode(code)).toMatch(BACKUP_CODE_PATTERN);
    }
  });

  it('treats spacing, dashes and capitals as the same code', () => {
    expect(normaliseBackupCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(hashBackupCode('abcde-fghjk')).toBe(hashBackupCode('ABCDEFGHJK'));
  });
});
