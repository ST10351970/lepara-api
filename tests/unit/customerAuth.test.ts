import { describe, expect, it } from 'vitest';
import {
  readAccessToken as readAdminToken,
  signAccessToken as signAdminToken,
} from '../../src/modules/adminAuth/adminAuth.tokens';
import {
  MAX_SENDS_PER_HOUR,
  SendThrottle,
  codeMatches,
  generateCode,
  hashCode,
} from '../../src/modules/customerAuth/customerAuth.codes';
import {
  registerSchema,
  resendCodeSchema,
} from '../../src/modules/customerAuth/customerAuth.schemas';
import {
  readAccessToken,
  readSignInToken,
  signAccessToken,
  signSignInToken,
} from '../../src/modules/customerAuth/customerAuth.tokens';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

describe('customer tokens', () => {
  it('reads back its own access token', () => {
    expect(readAccessToken(signAccessToken(42, 3))).toEqual({ customerId: 42, sessionVersion: 3 });
  });

  it('never accepts an admin token, and admins never accept a customer token', () => {
    expect(() => readAccessToken(signAdminToken(1, 0))).toThrow();
    expect(() => readAdminToken(signAccessToken(1, 0))).toThrow();
  });

  it('keeps the sign-in token and the access token apart', () => {
    const { token } = signSignInToken(42, 0);
    expect(() => readAccessToken(token)).toThrow();
    expect(() => readSignInToken(signAccessToken(42, 0))).toThrow();
    expect(readSignInToken(token)).toEqual({ customerId: 42, sessionVersion: 0 });
  });
});

describe('emailed codes', () => {
  it('are 6 digits and stored only as a hash', () => {
    for (let i = 0; i < 200; i += 1) expect(generateCode()).toMatch(/^\d{6}$/);
    const hash = hashCode('012345');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('012345');
    expect(codeMatches('012345', hash)).toBe(true);
    expect(codeMatches('012346', hash)).toBe(false);
  });

  it('can be sent once a minute and 5 times an hour', () => {
    let now = 0;
    const throttle = new SendThrottle(() => now);
    expect(throttle.take('a@example.com')).toBe(0);
    now += 30_000;
    expect(throttle.take('a@example.com')).toBe(30);
    expect(throttle.take('b@example.com')).toBe(0); // each address on its own
    for (let i = 1; i < MAX_SENDS_PER_HOUR; i += 1) {
      now += 61_000;
      expect(throttle.take('a@example.com')).toBe(0);
    }
    now += 61_000;
    expect(throttle.take('a@example.com')).toBeGreaterThan(60); // the hourly limit
    now += 60 * 60 * 1000;
    expect(throttle.take('a@example.com')).toBe(0);
  });
});

describe('sign-up form', () => {
  const valid = {
    firstName: 'Naledi',
    lastName: 'Mokoena',
    email: 'Naledi@Example.com',
    mobile: '071 234 5678',
    password: 'Winter-Blankets-2026',
    confirmPassword: 'Winter-Blankets-2026',
    acceptTerms: true,
  };

  it('cleans up the email and mobile number', () => {
    expect(registerSchema.parse(valid)).toMatchObject({
      email: 'naledi@example.com',
      mobile: '+27712345678',
    });
  });

  it('explains each problem under its field', () => {
    expect(
      firstMessages(
        registerSchema.safeParse({ ...valid, confirmPassword: 'Different-1', acceptTerms: false }),
      ),
    ).toEqual({
      acceptTerms: 'Please accept the terms and privacy policy to create an account.',
    });
    expect(
      firstMessages(registerSchema.safeParse({ ...valid, confirmPassword: 'Different-1' })),
    ).toEqual({ confirmPassword: "Your passwords don't match." });
  });

  it('resends by email or by sign-in token', () => {
    expect(resendCodeSchema.parse({ email: 'A@B.co' })).toEqual({ email: 'a@b.co' });
    expect(resendCodeSchema.parse({ pendingToken: 'abc' })).toEqual({ pendingToken: 'abc' });
    expect(resendCodeSchema.safeParse({}).success).toBe(false);
  });
});
