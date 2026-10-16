import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  productSubtitle,
  sizeRange,
} from '../../src/modules/products/products.format';
import {
  createProductSchema,
  createVariantSchema,
  publicListQuery,
  updateVariantSchema,
} from '../../src/modules/products/products.schemas';
import { formatPrice } from '../../src/utils/money';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) =>
  Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.') || 'request', issue.message]),
  );

describe('shop labels', () => {
  it('writes prices the way the app shows them', () => {
    expect(formatPrice(25_000)).toBe('R250');
    expect(formatPrice(25_050)).toBe('R250.50');
    expect(formatPrice(125_000)).toBe('R1 250');
    expect(formatPrice(99)).toBe('R0.99');
  });

  it('shows a word for stock, never the number', () => {
    expect(availabilityOf(0)).toBe('Sold out');
    expect(availabilityOf(1)).toBe('Low stock');
    expect(availabilityOf(3)).toBe('Low stock');
    expect(availabilityOf(4)).toBe('In stock');
  });

  it('describes the size range from smallest to largest', () => {
    expect(sizeRange(['XL', 'XS', 'M'])).toBe('XS–XL');
    expect(sizeRange(['One size'])).toBe('One size');
    expect(sizeRange([])).toBeNull();
    expect(productSubtitle('White', 'Cotton', ['XS', 'S', 'M', 'L', 'XL', 'XXL'])).toBe(
      'White / Cotton / XS–XXL',
    );
    expect(productSubtitle(null, 'Canvas', ['One size'])).toBe('Canvas / One size');
    expect(productSubtitle(null, null, [])).toBe('');
  });
});

describe('shop forms', () => {
  const product = { categoryId: 1, name: 'Community tee', price: 'R250' };

  it('reads prices in rands and keeps them as cents', () => {
    expect(createProductSchema.parse(product).price).toBe(25_000);
    expect(createProductSchema.parse({ ...product, price: 250.5 }).price).toBe(25_050);
    expect(firstMessages(createProductSchema.safeParse({ ...product, price: '0' }))).toEqual({
      price: 'The price must be more than R0.',
    });
  });

  it('starts new products hidden, with no sizes', () => {
    const parsed = createProductSchema.parse(product);
    expect(parsed.isActive).toBe(false);
    expect(parsed.variants).toEqual([]);
  });

  it('refuses the same size twice in one product', () => {
    const result = createProductSchema.safeParse({
      ...product,
      variants: [
        { size: 'M', sku: 'TEE-M' },
        { size: 'M', sku: 'TEE-M2' },
      ],
    });
    expect(firstMessages(result)).toEqual({
      'variants.1.size': 'Each size can only be listed once.',
    });
  });

  it('checks sizes, SKU codes and stock', () => {
    const ok = createVariantSchema.parse({ size: 'XL', sku: ' tee-wht-xl ' });
    expect(ok).toEqual({ size: 'XL', sku: 'TEE-WHT-XL', quantityOnHand: 0 });

    expect(
      firstMessages(
        createVariantSchema.safeParse({ size: 'XXXL', sku: 'a b', quantityOnHand: -1 }),
      ),
    ).toEqual({
      size: 'Please choose a size: XS, S, M, L, XL, XXL or One size.',
      sku: 'SKU codes are 2 to 40 letters, numbers or dashes, for example TEE-WHT-M.',
      quantityOnHand: "Stock can't be below 0.",
    });
    expect(firstMessages(updateVariantSchema.safeParse({}))).toEqual({
      request: 'Please change at least one detail.',
    });
  });

  it('ignores list filters it does not understand', () => {
    expect(publicListQuery.parse({ categoryId: 'tees', search: '  ' })).toEqual({
      page: 1,
      pageSize: 20,
      categoryId: undefined,
      search: undefined,
    });
  });
});
