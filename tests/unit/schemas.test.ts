import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  availability,
  consentGiven,
  description,
  emailAddress,
  idParam,
  isoDate,
  oneOf,
  pagination,
  password,
  passwordsMatch,
  personName,
  phoneLast4,
  postalCode,
  quantity,
  randsToCents,
  saPhoneNumber,
  searchText,
  sixDigitCode,
} from '../../src/schemas/common';

/** The first message Zod gives for a bad value, or null if the value is accepted. */
function messageFor(schema: z.ZodType, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'invalid');
}

describe('personName', () => {
  const name = personName();

  it('accepts real names', () => {
    for (const good of ['Naledi', "Thabo O'Neil", 'Mary-Jane', 'Zoë', 'Lerato Mokoena']) {
      expect(name.parse(good)).toBe(good);
    }
    expect(name.parse('  Sipho  ')).toBe('Sipho');
  });

  it('rejects missing, short, too long and non-letter names', () => {
    expect(messageFor(name, undefined)).toBe('Please enter your name.');
    expect(messageFor(name, 'A')).toMatch(/at least 2/);
    expect(messageFor(name, 'a'.repeat(61))).toMatch(/under 60/);
    expect(messageFor(name, 'R2D2')).toBe('Please enter your name using letters only.');
    expect(messageFor(name, '<script>')).toBe('Please enter your name using letters only.');
  });
});

describe('emailAddress', () => {
  it('trims and lower-cases', () => {
    expect(emailAddress.parse('  Naledi.Mokoena@Example.COM ')).toBe('naledi.mokoena@example.com');
  });

  it('rejects invalid addresses', () => {
    for (const bad of ['naledi', 'naledi@', '@example.com', 'naledi@example', 'a b@example.com']) {
      expect(messageFor(emailAddress, bad)).toMatch(/valid email/);
    }
    expect(messageFor(emailAddress, undefined)).toBe('Please enter your email address.');
  });
});

describe('saPhoneNumber', () => {
  it('stores every accepted format as +27...', () => {
    for (const input of [
      '071 234 5678',
      '0712345678',
      '+27 71 234 5678',
      '27712345678',
      '(011) 234-5678',
    ]) {
      expect(saPhoneNumber.parse(input)).toMatch(/^\+27[1-8]\d{8}$/);
    }
    expect(saPhoneNumber.parse('071 234 5678')).toBe('+27712345678');
  });

  it('rejects numbers that are not South African', () => {
    for (const bad of ['12345', '0912345678', '+44 20 7946 0958', '071234567', 'phone']) {
      expect(messageFor(saPhoneNumber, bad)).toMatch(/South African number/);
    }
  });

  it('checks the last 4 digits used for tracking', () => {
    expect(phoneLast4.parse(' 5678 ')).toBe('5678');
    expect(messageFor(phoneLast4, '567')).toMatch(/last 4 digits/);
  });
});

describe('password', () => {
  it('accepts a reasonable password', () => {
    expect(messageFor(password, 'Ubuntu2026!')).toBeNull();
  });

  it('explains what is missing', () => {
    expect(messageFor(password, 'short1')).toMatch(/at least 8/);
    expect(messageFor(password, 'onlyletters')).toMatch(/one number/);
    expect(messageFor(password, '1234567890')).toMatch(/one letter/);
    expect(messageFor(password, 'a1'.repeat(40))).toMatch(/at most 64/);
    expect(messageFor(password, 'Password123')).toMatch(/too common/);
  });

  it('checks that the confirmation matches', () => {
    const form = z
      .object({ password, confirmPassword: z.string() })
      .superRefine(passwordsMatch('password', 'confirmPassword'));
    const result = form.safeParse({ password: 'Ubuntu2026!', confirmPassword: 'Ubuntu2025!' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['confirmPassword'],
      message: "Your passwords don't match.",
    });
  });
});

describe('codes, text and addresses', () => {
  it('accepts exactly six digits', () => {
    expect(sixDigitCode.parse(' 123456 ')).toBe('123456');
    expect(messageFor(sixDigitCode, '12345')).toMatch(/6-digit/);
    expect(messageFor(sixDigitCode, '12345a')).toMatch(/6-digit/);
  });

  it('asks for a little more description', () => {
    expect(messageFor(description(), 'short')).toMatch(/at least 10/);
    expect(messageFor(description(), 'x'.repeat(1001))).toMatch(/under 1000/);
    expect(description().parse('  Warm clothing for two children  ')).toBe(
      'Warm clothing for two children',
    );
  });

  it('checks availability and postal codes', () => {
    expect(messageFor(availability, 'no')).toMatch(/when you are available/);
    expect(postalCode.parse('1804')).toBe('1804');
    expect(messageFor(postalCode, '180')).toBe('Postal codes have 4 digits.');
  });
});

describe('randsToCents', () => {
  const amount = randsToCents();

  it('returns cents from text or numbers', () => {
    expect(amount.parse('250.50')).toBe(25050);
    expect(amount.parse(250)).toBe(25000);
  });

  it('rejects bad and too-large amounts', () => {
    expect(messageFor(amount, 'ten')).toMatch(/amount in rands/);
    expect(messageFor(amount, '-5')).toMatch(/amount in rands/);
    expect(messageFor(amount, '1000000.01')).toMatch(/up to R/);
    expect(messageFor(amount, true)).toMatch(/amount in rands/);
  });
});

describe('quantity, choices, consent and dates', () => {
  it('accepts whole numbers in range only', () => {
    const lineQuantity = quantity(1, 10);
    expect(lineQuantity.parse(3)).toBe(3);
    expect(messageFor(lineQuantity, 0)).toMatch(/from 1 to 10/);
    expect(messageFor(lineQuantity, 11)).toMatch(/from 1 to 10/);
    expect(messageFor(lineQuantity, 2.5)).toMatch(/whole number/);
    expect(messageFor(lineQuantity, '3')).toMatch(/whole number/);
  });

  it('accepts only listed options', () => {
    const size = oneOf(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size'] as const);
    expect(size.parse('M')).toBe('M');
    expect(messageFor(size, 'XXXL')).toBe('Please choose one of the options.');
  });

  it('requires consent to be ticked', () => {
    expect(consentGiven.parse(true)).toBe(true);
    expect(messageFor(consentGiven, false)).toMatch(/tick the box/);
    expect(messageFor(consentGiven, 'true')).toMatch(/tick the box/);
  });

  it('accepts real dates only', () => {
    expect(isoDate.parse('2026-10-24')).toBe('2026-10-24');
    expect(messageFor(isoDate, '24/10/2026')).toMatch(/YYYY-MM-DD/);
    expect(messageFor(isoDate, '2026-02-30')).toBe('Please enter a real date.');
  });
});

describe('IDs, paging and search', () => {
  it('accepts positive whole-number IDs from the URL', () => {
    expect(idParam.parse({ id: '42' })).toEqual({ id: 42 });
    for (const bad of ['abc', '0', '-1', '1.5', '99999999999', "1' OR '1'='1"]) {
      expect(messageFor(idParam, { id: bad })).toBe("We couldn't find that item.");
    }
  });

  it('falls back to sensible paging instead of failing', () => {
    expect(pagination.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pagination.parse({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10 });
    expect(pagination.parse({ page: 'abc', pageSize: '500' })).toEqual({ page: 1, pageSize: 50 });
    expect(pagination.parse({ page: '-4', pageSize: '0' })).toEqual({ page: 1, pageSize: 1 });
  });

  it('trims search text and cuts it to 100 characters', () => {
    expect(searchText.parse('  hoodie ')).toBe('hoodie');
    expect(searchText.parse('   ')).toBeUndefined();
    expect(searchText.parse(undefined)).toBeUndefined();
    expect(searchText.parse('x'.repeat(150))).toHaveLength(100);
  });
});
