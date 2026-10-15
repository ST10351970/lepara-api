import { describe, expect, it } from 'vitest';
import { isRealIsoDate, todayInJohannesburg } from '../../src/utils/dates';

describe('todayInJohannesburg', () => {
  it('uses South African time, two hours ahead of UTC', () => {
    // 23:30 UTC on 23 October is already 01:30 on 24 October in Johannesburg.
    expect(todayInJohannesburg(new Date('2026-10-23T23:30:00Z'))).toBe('2026-10-24');
    expect(todayInJohannesburg(new Date('2026-10-23T21:59:00Z'))).toBe('2026-10-23');
  });
});

describe('isRealIsoDate', () => {
  it('accepts real dates', () => {
    expect(isRealIsoDate('2026-10-24')).toBe(true);
    expect(isRealIsoDate('2028-02-29')).toBe(true);
  });

  it('rejects impossible or badly written dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2027-02-29', '24-10-2026', '2026/10/24', '']) {
      expect(isRealIsoDate(bad)).toBe(false);
    }
  });
});
