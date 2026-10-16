/**
 * Ready-made text for the app's Shop screens, so every screen shows sizes
 * and stock the same way.
 */

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size'] as const;
export type Size = (typeof SIZES)[number];

/** At or below this many left, a size shows as "Low stock". */
export const LOW_STOCK_AT = 3;

export type Availability = 'In stock' | 'Low stock' | 'Sold out';

/** The app shows a word, never the exact number left. */
export function availabilityOf(quantityOnHand: number): Availability {
  if (quantityOnHand <= 0) return 'Sold out';
  return quantityOnHand <= LOW_STOCK_AT ? 'Low stock' : 'In stock';
}

/** Sizes from smallest to largest, as the size picker shows them. */
export function sortSizes<T extends { size: string }>(variants: T[]): T[] {
  const rank = (size: string) => {
    const index = SIZES.indexOf(size as Size);
    return index === -1 ? SIZES.length : index;
  };
  return [...variants].sort((a, b) => rank(a.size) - rank(b.size));
}

/** ["XS", "S", "M"] → "XS–M"; ["One size"] → "One size"; [] → null. */
export function sizeRange(sizes: string[]): string | null {
  const sorted = sortSizes(sizes.map((size) => ({ size }))).map((entry) => entry.size);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  return `${sorted[0]}–${sorted[sorted.length - 1]}`;
}

/** The line under a product card: "White / Cotton / XS–XXL". */
export function productSubtitle(
  colour: string | null,
  material: string | null,
  sizes: string[],
): string {
  return [colour, material, sizeRange(sizes)].filter(Boolean).join(' / ');
}
