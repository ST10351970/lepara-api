import { z } from 'zod';
import { isoDate, pagination, randsToCents, searchText, shortText } from '../../schemas/common';
import type { FieldError } from '../../utils/AppError';
import { todayInJohannesburg } from '../../utils/dates';
import { itemQuantity, reason, stockItemId } from '../stock/stock.schemas';

/** What the donation endpoints accept. Messages appear on the website's forms. */

export const DONATION_TYPES = ['Monetary', 'Goods'] as const;
export type DonationType = (typeof DONATION_TYPES)[number];

/** Large gifts happen; the database column holds up to R99,999,999.99. */
const MAX_DONATION_RANDS = 10_000_000;

const amount = randsToCents(MAX_DONATION_RANDS).refine(
  (cents) => cents > 0,
  'The amount must be more than R0.',
);

const receiptReference = shortText('Please enter the receipt or bank reference.', 1, 50);

/** Forms often send "" or null for a field left empty: treat both as "not given". */
function optional<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    schema.optional(),
  );
}

/** The day it arrived: today or earlier (Johannesburg). Defaults to today. */
const dateReceived = optional(
  isoDate.refine(
    (date) => date <= todayInJohannesburg(),
    "The date received can't be in the future.",
  ),
);

/** The parts that depend on the type: money, or goods counted into stock. */
const donationParts = {
  amount: optional(amount),
  receiptReference: optional(receiptReference),
  stockItemId: optional(stockItemId),
  quantity: optional(itemQuantity),
  dateReceived,
};

type DonationParts = {
  amount?: number;
  receiptReference?: string;
  stockItemId?: number;
  quantity?: number;
};

/**
 * The Task 1 rule (Section 8.4): a monetary donation has an amount and no
 * goods; a goods donation has a stock item and a quantity and no amount.
 * Returns one message per field that breaks it.
 */
export function donationShapeProblems(type: DonationType, parts: DonationParts): FieldError[] {
  const problems: FieldError[] = [];
  if (type === 'Monetary') {
    if (parts.amount === undefined) {
      problems.push({ field: 'amount', message: 'Please enter the amount received, in rands.' });
    }
    if (parts.quantity !== undefined) {
      problems.push({
        field: 'quantity',
        message: 'A monetary donation has no quantity. Record goods as a goods donation.',
      });
    }
    if (parts.stockItemId !== undefined) {
      problems.push({
        field: 'stockItemId',
        message: "A monetary donation doesn't go into stock. Record goods as a goods donation.",
      });
    }
  } else {
    if (parts.stockItemId === undefined) {
      problems.push({ field: 'stockItemId', message: 'Please choose the stock item received.' });
    }
    if (parts.quantity === undefined) {
      problems.push({ field: 'quantity', message: 'Please enter how many were received.' });
    }
    if (parts.amount !== undefined) {
      problems.push({
        field: 'amount',
        message: 'A goods donation has no amount. Record money as a monetary donation.',
      });
    }
  }
  return problems;
}

function addShapeIssues(type: DonationType, parts: DonationParts, ctx: z.RefinementCtx) {
  for (const problem of donationShapeProblems(type, parts)) {
    ctx.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
  }
}

/** POST /admin/donations */
export const createDonationSchema = z
  .object({
    type: z.enum(DONATION_TYPES, { error: 'Please choose Monetary or Goods.' }),
    donorName: optional(shortText("Please enter the donor's name.", 2, 150)),
    /** Keep the donor's name off anything public, such as reports. */
    isAnonymous: z.boolean({ error: 'Please choose yes or no.' }).default(false),
    initiativeId: optional(
      z
        .number({ error: 'Please choose one of the events.' })
        .int('Please choose one of the events.')
        .positive('Please choose one of the events.')
        .max(2_147_483_647, 'Please choose one of the events.'),
    ),
    ...donationParts,
  })
  .superRefine((body, ctx) => {
    if (!body.donorName && !body.isAnonymous) {
      ctx.addIssue({
        code: 'custom',
        path: ['donorName'],
        message: "Please enter the donor's name, or tick anonymous.",
      });
    }
    addShapeIssues(body.type, body, ctx);
  });
export type CreateDonationInput = z.infer<typeof createDonationSchema>;

/**
 * POST /admin/donation-pledges/:id/receive. The donor and event come from the
 * pledge. The type defaults to the pledge's category (Monetary, or Goods for
 * the others); its parts are checked once the type is known.
 */
export const receivePledgeSchema = z.object({
  type: z.enum(DONATION_TYPES, { error: 'Please choose Monetary or Goods.' }).optional(),
  ...donationParts,
});
export type ReceivePledgeInput = z.infer<typeof receivePledgeSchema>;

/** POST /admin/donations/:id/void */
export const voidDonationSchema = z.object({
  reason: reason('Please say why this donation is being voided, for example "Recorded twice".'),
});
export type VoidDonationInput = z.infer<typeof voidDonationSchema>;

const optionalId = z.coerce
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .optional()
  .catch(undefined);

/** GET /admin/donations */
export const donationListQuery = pagination.extend({
  type: z.enum(DONATION_TYPES).optional().catch(undefined),
  status: z.enum(['active', 'voided', 'all']).catch('all'),
  initiativeId: optionalId,
  stockItemId: optionalId,
  from: isoDate.optional().catch(undefined),
  to: isoDate.optional().catch(undefined),
  search: searchText,
  sort: z.string().optional().catch(undefined),
});
export type DonationListQuery = z.infer<typeof donationListQuery>;
