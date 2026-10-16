/**
 * Money is handled as whole cents (integers) everywhere, so there is never a
 * floating-point rounding error: R250.50 is 25050.
 * Task 1's DONATION.amount is numeric(10,2); PostgreSQL returns it as a string
 * such as "250.50", converted here without passing through a float.
 */

const RANDS_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/** "250", "250.5", "R 250.50", 250.5 → cents. Returns null if it is not a valid amount. */
export function parseRandsToCents(input: string | number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    const cents = Math.round(input * 100);
    // More than two decimals (e.g. 1.005) is not a valid amount.
    if (Math.abs(input * 100 - cents) > 1e-6) return null;
    return Number.isSafeInteger(cents) ? cents : null;
  }

  const cleaned = input.trim().replace(/^R\s*/i, '');
  if (!RANDS_PATTERN.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** A numeric(10,2) string from PostgreSQL ("250.50") → 25050. */
export function numericToCents(value: string): number {
  const cents = parseRandsToCents(value);
  if (cents === null) throw new Error(`Not a valid amount: ${value}`);
  return cents;
}

/** 25050 → "250.50", for writing to a numeric(10,2) column. */
export function centsToNumeric(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error(`Not a valid amount in cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** 125050 → "R1 250.50", the way amounts are shown to people. */
export function formatRand(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R${whole}.${String(absolute % 100).padStart(2, '0')}`;
}

/** 25000 → "R250", 25050 → "R250.50", 125000 → "R1 250": prices on product cards. */
export function formatPrice(cents: number): string {
  const full = formatRand(cents);
  return full.endsWith('.00') ? full.slice(0, -3) : full;
}
