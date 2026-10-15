import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  formatSecretForTyping,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from '../../src/utils/totp';

// The secret used by the RFCs' own test values: the ASCII text "12345678901234567890".
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('Base32 (RFC 4648, section 10)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  for (const [text, encoded] of vectors) {
    it(`encodes "${text}" as "${encoded}" and back`, () => {
      expect(base32Encode(Buffer.from(text))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(text);
    });
  }

  it('reads secrets typed with spaces, lower case or padding', () => {
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(base32Encode(RFC_KEY)).toBe(RFC_SECRET);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW1')).toThrow(/Base32/);
  });
});

describe('HOTP (RFC 4226, appendix D)', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  expected.forEach((code, counter) => {
    it(`gives ${code} for counter ${counter}`, () => {
      expect(hotp(RFC_KEY, counter)).toBe(code);
    });
  });
});

describe('TOTP (RFC 6238, appendix B, SHA-1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, code] of vectors) {
    it(`gives ${code} at ${seconds} seconds`, () => {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
      // Authenticator apps show the last 6 digits.
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code.slice(-6));
    });
  }
});

describe('verifyTotp', () => {
  const now = 1_760_000_000_000; // a fixed moment, so the test never depends on the clock
  const step = totpStep(now);

  it('accepts the current code and returns its time step', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { timeMs: now })).toBe(step);
  });

  it('accepts the previous and next code, for a phone clock that is slightly off', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { timeMs: now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { timeMs: now })).toBe(step + 1);
  });

  it('refuses codes from more than 30 seconds away', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { timeMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), { timeMs: now })).toBeNull();
  });

  it('refuses anything that is not 6 digits', () => {
    expect(verifyTotp(RFC_SECRET, '12345', { timeMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345a', { timeMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '', { timeMs: now })).toBeNull();
  });
});

describe('secrets and QR codes', () => {
  it('makes a new 160-bit secret each time', () => {
    const first = generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(first)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(first);
  });

  it('builds the link authenticator apps expect', () => {
    const url = otpauthUrl({
      issuer: 'Lepara Ale fele Moya',
      account: 'founder',
      secret: RFC_SECRET,
    });
    expect(url).toBe(
      `otpauth://totp/Lepara%20Ale%20fele%20Moya:founder?secret=${RFC_SECRET}` +
        '&issuer=Lepara%20Ale%20fele%20Moya&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('groups the secret in fours for typing', () => {
    expect(formatSecretForTyping('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
