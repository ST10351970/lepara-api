import { z } from 'zod';
import {
  city,
  pagination,
  personName,
  postalCode,
  quantity,
  saPhoneNumber,
  streetAddress,
} from '../../schemas/common';
import { ORDER_NUMBER_PATTERN, PAYMENT_METHODS } from './orders.format';

/**
 * What the app sends for the checkout. Only the size (variantId) and quantity
 * of each line are read: any price, name or total in the request is dropped,
 * because the server works those out from the database.
 */

const ITEM_MESSAGE = 'This item is no longer available. Please remove it from your bag.';

/** A size picked on the product page (its variantId). Accepts 12 or "12". */
const variantId = z.preprocess(
  (value) => (typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value) : value),
  z
    .number({ error: ITEM_MESSAGE })
    .int(ITEM_MESSAGE)
    .positive(ITEM_MESSAGE)
    .max(2_147_483_647, ITEM_MESSAGE),
);

const cartLine = z.object({
  variantId,
  quantity: quantity(1, 10),
});

export const MAX_CART_LINES = 20;

const cartItems = z
  .array(cartLine, { error: 'Your bag is empty.' })
  .min(1, 'Your bag is empty.')
  .max(MAX_CART_LINES, `You can order up to ${MAX_CART_LINES} different items at once.`)
  .superRefine((lines, ctx) => {
    const seen = new Set<number>();
    lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'variantId'],
          message: 'This size is already in your bag. Change its quantity instead.',
        });
      }
      seen.add(line.variantId);
    });
  });

/** POST /cart/quote */
export const quoteSchema = z.object({ items: cartItems });

/** POST /orders */
export const placeOrderSchema = z.object({
  items: cartItems,
  recipientName: personName("the recipient's name", 120),
  streetAddress,
  city,
  postalCode,
  phone: saPhoneNumber,
  paymentMethod: z.enum(PAYMENT_METHODS, {
    error: 'Please choose EFT bank transfer or cash on delivery.',
  }),
  acceptTerms: z.literal(true, {
    error: 'Please tick the box to agree to the terms before placing your order.',
  }),
});

/** :orderNumber in a URL, e.g. LAFM-1008 (any capitals). */
export const orderNumberParams = z.object({
  orderNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(ORDER_NUMBER_PATTERN, "We couldn't find that order."),
});

/** POST /me/orders/:orderNumber/cancel. The reason is optional. */
export const cancelOrderSchema = z.object({
  reason: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string({ error: 'Please enter text.' })
      .trim()
      .max(500, 'Please keep this under 500 characters.')
      .optional(),
  ),
});

/** GET /me/orders?page=&pageSize= */
export const myOrdersQuery = pagination;

export type QuoteInput = z.infer<typeof quoteSchema>;
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type OrderNumberParams = z.infer<typeof orderNumberParams>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type MyOrdersQuery = z.infer<typeof myOrdersQuery>;
