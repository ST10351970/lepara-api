import { env } from '../../config/env';
import { AppError, ErrorCode, type FieldError } from '../../utils/AppError';
import { formatPrice } from '../../utils/money';
import { type Availability, availabilityOf } from '../products/products.format';
import { sizeLabel } from './orders.format';

/**
 * The one pricing function. The checkout summary (POST /cart/quote) and the
 * order itself (POST /orders) both use it, so the total the customer sees is
 * the total they are charged.
 *
 *  - Prices come only from the database. Any price or total in the request is
 *    ignored (the schemas don't even read them).
 *  - Money is whole cents: line total = unit price × quantity, subtotal = the
 *    sum of the lines, total = subtotal + the delivery fee (DELIVERY_FEE_CENTS).
 *  - A line that can't be ordered as asked carries a `problem` the app can show
 *    under it. The quote lists every problem; the order refuses with 409.
 */

export type CartLineInput = { variantId: number; quantity: number };

/** A size for sale, as read from the database. */
export type VariantForSale = {
  variantId: number;
  productId: number;
  size: string;
  quantityOnHand: number;
  productName: string;
  priceCents: number;
  isActive: boolean;
  imageUrl: string | null;
};

export type PricedLine = {
  variantId: number;
  productId: number | null;
  name: string | null;
  size: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number | null;
  unitPrice: string | null;
  lineTotalCents: number | null;
  lineTotal: string | null;
  /** "Unavailable": the product was removed from the shop or the size no longer exists. */
  availability: Availability | 'Unavailable';
  problem: string | null;
};

export type PricedCart = {
  lines: PricedLine[];
  itemCount: number;
  subtotalCents: number;
  subtotal: string;
  deliveryFeeCents: number;
  deliveryFee: string;
  totalCents: number;
  total: string;
  canPlaceOrder: boolean;
};

function unavailable(line: CartLineInput, variant: VariantForSale | undefined): PricedLine {
  const name = variant?.productName ?? null;
  return {
    variantId: line.variantId,
    productId: variant?.productId ?? null,
    name,
    size: variant?.size ?? null,
    imageUrl: variant?.imageUrl ?? null,
    quantity: line.quantity,
    unitPriceCents: null,
    unitPrice: null,
    lineTotalCents: null,
    lineTotal: null,
    availability: 'Unavailable',
    problem: `${name ?? 'This item'} is no longer available. Please remove it from your bag.`,
  };
}

/** What's wrong with asking for `quantity` of this size, or null if nothing. */
function stockProblem(variant: VariantForSale, quantity: number): string | null {
  const what = `${variant.productName} (${sizeLabel(variant.size)})`;
  if (variant.quantityOnHand <= 0) {
    return `${what} is sold out. Please remove it or choose another size.`;
  }
  if (quantity > variant.quantityOnHand) {
    return `${what}: only ${variant.quantityOnHand} left. Please lower the quantity.`;
  }
  return null;
}

export function priceCart(
  requested: CartLineInput[],
  variants: Map<number, VariantForSale>,
  deliveryFeeCents: number = env.DELIVERY_FEE_CENTS,
): PricedCart {
  const lines = requested.map((line): PricedLine => {
    const variant = variants.get(line.variantId);
    if (!variant || !variant.isActive) return unavailable(line, variant);
    const lineTotalCents = variant.priceCents * line.quantity;
    return {
      variantId: variant.variantId,
      productId: variant.productId,
      name: variant.productName,
      size: variant.size,
      imageUrl: variant.imageUrl,
      quantity: line.quantity,
      unitPriceCents: variant.priceCents,
      unitPrice: formatPrice(variant.priceCents),
      lineTotalCents,
      lineTotal: formatPrice(lineTotalCents),
      availability: availabilityOf(variant.quantityOnHand),
      problem: stockProblem(variant, line.quantity),
    };
  });

  const priced = lines.filter((line) => line.lineTotalCents !== null);
  const subtotalCents = priced.reduce((sum, line) => sum + line.lineTotalCents!, 0);
  // Delivery is charged once, when there is something to deliver.
  const delivery = priced.length > 0 ? deliveryFeeCents : 0;
  const totalCents = subtotalCents + delivery;

  return {
    lines,
    itemCount: priced.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents,
    subtotal: formatPrice(subtotalCents),
    deliveryFeeCents: delivery,
    deliveryFee: formatPrice(delivery),
    totalCents,
    total: formatPrice(totalCents),
    canPlaceOrder: lines.length > 0 && lines.every((line) => line.problem === null),
  };
}

/** Each problem under its line in the bag: items.0, items.1, ... */
export function cartProblems(cart: PricedCart): FieldError[] {
  return cart.lines.flatMap((line, index) =>
    line.problem ? [{ field: `items.${index}`, message: line.problem }] : [],
  );
}

/** 409 for an order that can't be placed as it is, naming each item and how many are left. */
export function cartConflict(cart: PricedCart): AppError {
  const problems = cartProblems(cart);
  const message =
    problems.length === 1
      ? problems[0]!.message
      : 'Some items in your bag have changed. Please check them and try again.';
  return new AppError(409, ErrorCode.CONFLICT, message, problems);
}
