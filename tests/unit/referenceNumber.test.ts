import { describe, expect, it } from 'vitest';
import {
  REFERENCE_ALPHABET,
  REFERENCE_PATTERN,
  ReferencePrefix,
  generateReference,
  normaliseReference,
  withUniqueReference,
} from '../../src/utils/referenceNumber';

describe('generateReference', () => {
  it('uses the format PREFIX-XXXXXX', () => {
    expect(generateReference(ReferencePrefix.assistanceRequest)).toMatch(/^REQ-[A-Z2-9]{6}$/);
    expect(generateReference(ReferencePrefix.volunteerApplication)).toMatch(/^VOL-/);
    expect(generateReference(ReferencePrefix.donationPledge)).toMatch(/^PLG-/);
  });

  it('never uses characters people confuse (0, O, 1, I) in 10,000 references', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const code = generateReference(ReferencePrefix.assistanceRequest).slice(4);
      expect(code).not.toMatch(/[0O1I]/);
      expect(REFERENCE_PATTERN.test(`REQ-${code}`)).toBe(true);
    }
  });

  it('spreads across the alphabet (not stuck on a few characters)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      for (const character of generateReference(ReferencePrefix.donationPledge).slice(4)) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(REFERENCE_ALPHABET.length);
  });

  it('fits the varchar(20) reference_number columns', () => {
    expect(generateReference(ReferencePrefix.assistanceRequest).length).toBeLessThan(21);
  });
});

describe('normaliseReference', () => {
  it('accepts what people type', () => {
    expect(normaliseReference('req-7k3p9x')).toBe('REQ-7K3P9X');
    expect(normaliseReference('REQ 7K3 P9X')).toBe('REQ-7K3P9X');
    expect(normaliseReference('req7k3p9x')).toBe('REQ-7K3P9X');
  });
});

describe('withUniqueReference', () => {
  const clash = {
    code: '23505',
    severity: 'ERROR',
    constraint: 'assistance_request_reference_number_key',
  };

  it('tries again with a new reference when the database reports a clash', async () => {
    const tried: string[] = [];
    const saved = await withUniqueReference(
      ReferencePrefix.assistanceRequest,
      async (reference) => {
        tried.push(reference);
        if (tried.length < 3) throw clash;
        return reference;
      },
    );
    expect(tried).toHaveLength(3);
    expect(saved).toBe(tried[2]);
  });

  it('gives up after the maximum number of attempts', async () => {
    let attempts = 0;
    const failing = withUniqueReference(
      ReferencePrefix.assistanceRequest,
      async () => {
        attempts += 1;
        throw clash;
      },
      4,
    );
    await expect(failing).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(4);
  });

  it('does not retry other errors', async () => {
    let attempts = 0;
    const failing = withUniqueReference(ReferencePrefix.assistanceRequest, async () => {
      attempts += 1;
      throw { code: '23505', severity: 'ERROR', constraint: 'customer_email_key' };
    });
    await expect(failing).rejects.toMatchObject({ constraint: 'customer_email_key' });
    expect(attempts).toBe(1);
  });
});
