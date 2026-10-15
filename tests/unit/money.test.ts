import { describe, expect, it } from 'vitest';
import {
  centsToNumeric,
  formatRand,
  numericToCents,
  parseRandsToCents,
} from '../../src/utils/money';

describe('parseRandsToCents', () => {
  it('reads whole rands and cents from text', () => {
    expect(parseRandsToCents('250')).toBe(25000);
    expect(parseRandsToCents('250.5')).toBe(25050);
    expect(parseRandsToCents('250.50')).toBe(25050);
    expect(parseRandsToCents(' R 1000 ')).toBe(100000);
    expect(parseRandsToCents('0')).toBe(0);
  });

  it('reads numbers without floating-point drift', () => {
    expect(parseRandsToCents(250.5)).toBe(25050);
    expect(parseRandsToCents(0.1 + 0.2)).toBe(30);
    expect(parseRandsToCents(19.99)).toBe(1999);
  });

  it('rejects anything that is not a valid amount', () => {
    for (const bad of ['', 'abc', '-5', '1.005', '1,50', '1e3', '12.', '.5', 'R']) {
      expect(parseRandsToCents(bad)).toBeNull();
    }
    expect(parseRandsToCents(-1)).toBeNull();
    expect(parseRandsToCents(1.005)).toBeNull();
    expect(parseRandsToCents(Number.NaN)).toBeNull();
    expect(parseRandsToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('numeric columns', () => {
  it('converts PostgreSQL numeric strings to cents and back', () => {
    expect(numericToCents('250.50')).toBe(25050);
    expect(numericToCents('1000000.00')).toBe(100000000);
    expect(centsToNumeric(25050)).toBe('250.50');
    expect(centsToNumeric(5)).toBe('0.05');
    expect(centsToNumeric(0)).toBe('0.00');
  });

  it('refuses invalid cents', () => {
    expect(() => centsToNumeric(-1)).toThrow();
    expect(() => centsToNumeric(1.5)).toThrow();
    expect(() => numericToCents('abc')).toThrow();
  });
});

describe('formatRand', () => {
  it('formats amounts the way people read them', () => {
    expect(formatRand(25000)).toBe('R250.00');
    expect(formatRand(125050)).toBe('R1 250.50');
    expect(formatRand(100000000)).toBe('R1 000 000.00');
    expect(formatRand(5)).toBe('R0.05');
    expect(formatRand(-500)).toBe('-R5.00');
  });
});
