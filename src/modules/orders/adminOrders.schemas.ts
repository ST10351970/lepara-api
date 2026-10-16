import { z } from 'zod';
import { isoDate, oneOf, pagination, randsToCents, searchText } from '../../schemas/common';
import { ORDER_STATUSES } from './orders.format';

/**
 * What the dashboard sends for orders. List filters that can't be understood
 * are ignored; changes are checked strictly, with a message for each field.
 */

// --- GET /admin/orders --------------------------------------------------------------------

export const adminOrderListQuery = pagination.extend({
  status: z.union([z.enum(ORDER_STATUSES), z.literal('all')]).catch('all'),
  paymentStatus: z.enum(['Unpaid', 'Paid', 'Refunded']).optional().catch(undefined),
  paymentMethod: z.enum(['EFT', 'Cash on delivery']).optional().catch(undefined),
  from: isoDate.optional().catch(undefined),
  to: isoDate.optional().catch(undefined),
  search: searchText,
  sort: z.string().optional().catch(undefined),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuery>;

// --- PATCH /admin/orders/:id/status -----------------------------------------------------------

/** Empty text counts as not given. */
function optionalText<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    schema.optional(),
  );
}

const COURIER_MESSAGE = "Please enter the courier's tracking reference, for example TCG123456789.";

const courierReference = z
  .string({ error: COURIER_MESSAGE })
  .trim()
  .min(3, COURIER_MESSAGE)
  .max(60, 'Please keep the courier reference under 60 characters.')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .#:/-]*$/u, COURIER_MESSAGE);

const reason = z
  .string({ error: 'Please enter text.' })
  .trim()
  .min(3, 'Please give a reason for cancelling (at least 3 characters).')
  .max(500, 'Please keep the reason under 500 characters.');

export const orderStatusSchema = z
  .object({
    /** Packed, Shipped, Delivered or Cancelled. Others get a 409 explaining why. */
    status: oneOf(ORDER_STATUSES),
    /** Required for Shipped. */
    courierReference: optionalText(courierReference),
    /** Required for Cancelled; the customer sees it in the cancellation email. */
    reason: optionalText(reason),
    /** For cancelling a paid order: true once the customer's money has been paid back. */
    refunded: z.boolean({ error: 'Please answer true or false.' }).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.status === 'Shipped' && !input.courierReference) {
      ctx.addIssue({ code: 'custom', path: ['courierReference'], message: COURIER_MESSAGE });
    }
    if (input.status === 'Cancelled' && !input.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Please give a reason for cancelling (at least 3 characters).',
      });
    }
  });
export type OrderStatusInput = z.infer<typeof orderStatusSchema>;

// --- PATCH /admin/orders/:id/payment ---------------------------------------------------------

export const orderPaymentSchema = z.object({
  /** In rands, e.g. 310 or "310.00". Must equal the order total. */
  amount: randsToCents(1_000_000),
  /**
   * EFT: the reference on the bank statement (the order number if left empty).
   * Cash on delivery: a receipt number, if there is one.
   */
  reference: optionalText(
    z
      .string({ error: 'Please enter text.' })
      .trim()
      .min(2, 'Please enter the reference (at least 2 characters).')
      .max(100, 'Please keep the reference under 100 characters.'),
  ),
});
export type OrderPaymentInput = z.infer<typeof orderPaymentSchema>;
