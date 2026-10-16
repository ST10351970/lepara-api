import { z } from 'zod';
import { pagination, quantity, requiredText, searchText, shortText } from '../../schemas/common';

/** What the stock endpoints accept. Messages appear on the website's forms. */

export const MAX_QUANTITY = 100_000;

/** A stock item picked from a list. */
export const stockItemId = z
  .number({ error: 'Please choose a stock item.' })
  .int('Please choose a stock item.')
  .positive('Please choose a stock item.')
  .max(2_147_483_647, 'Please choose a stock item.');

/** How many of something: a whole number from 1 to 100,000. */
export const itemQuantity = quantity(1, MAX_QUANTITY);

/** Why stock changed by hand, or why a donation was voided. Kept in the history. */
export const reason = (missing: string) =>
  requiredText(missing)
    .trim()
    .min(3, missing)
    .max(300, 'Please keep the reason under 300 characters.');

// --- Stock items ---------------------------------------------------------------------------

/** GET /admin/stock-items?search=&category=&low=true&sort=name|quantity|category */
export const stockListQuery = pagination.extend({
  search: searchText,
  category: searchText,
  low: z
    .enum(['true', 'false'])
    .optional()
    .catch(undefined)
    .transform((value) => value === 'true'),
  sort: z.string().optional().catch(undefined),
});
export type StockListQuery = z.infer<typeof stockListQuery>;

const itemName = shortText('Please enter the item name, for example Blankets.', 2, 150);
const category = shortText('Please enter a category, for example Bedding.', 2, 100);
const unit = shortText('Please enter the unit it is counted in, for example blanket.', 1, 50);
const reorderLevel = z
  .number({ error: 'Please enter the low-stock level as a whole number.' })
  .int('Please enter the low-stock level as a whole number.')
  .min(0, "The low-stock level can't be below 0.")
  .max(MAX_QUANTITY, `The low-stock level can be at most ${MAX_QUANTITY.toLocaleString('en-ZA')}.`);

/** POST /admin/stock-items. openingQuantity is recorded as a movement, so history adds up. */
export const createStockItemSchema = z.object({
  name: itemName,
  category: category.nullable().optional(),
  unit,
  reorderLevel: reorderLevel.default(0),
  openingQuantity: z
    .number({ error: 'Please enter the opening stock as a whole number.' })
    .int('Please enter the opening stock as a whole number.')
    .min(0, "Opening stock can't be below 0.")
    .max(MAX_QUANTITY, `Opening stock can be at most ${MAX_QUANTITY.toLocaleString('en-ZA')}.`)
    .default(0),
});
export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;

const CHANGE_STOCK_MESSAGE =
  'Stock levels only change through a donation, a fulfilled request or a stock adjustment, so the history always adds up.';

/** PATCH /admin/stock-items/:id. The quantity can't be set here. */
export const updateStockItemSchema = z
  .object({
    name: itemName.optional(),
    category: category.nullable().optional(),
    unit: unit.optional(),
    reorderLevel: reorderLevel.optional(),
    quantityOnHand: z.undefined({ error: CHANGE_STOCK_MESSAGE }).optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Please change at least one detail.',
  );
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;

// --- Adjustments and fulfilment ------------------------------------------------------------

/** POST /admin/stock-movements: a correction by hand (damaged goods, a recount, ...). */
export const adjustmentSchema = z.object({
  stockItemId,
  type: z.enum(['Increase', 'Decrease'], { error: 'Please choose Increase or Decrease.' }),
  quantity: itemQuantity,
  reason: reason('Please say why the stock changed, for example "3 blankets damaged by water".'),
});
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

/**
 * POST /admin/assistance-requests/:id/fulfil. items may be empty when the help
 * given wasn't goods (Task 1, UC-03 alternate flow A2).
 */
export const fulfilSchema = z.object({
  items: z
    .array(z.object({ stockItemId, quantity: itemQuantity }), {
      error: 'Please list the items given, or send an empty list if no goods were given.',
    })
    .max(20, 'Please list at most 20 different items.')
    .superRefine((items, ctx) => {
      const seen = new Set<number>();
      items.forEach((item, index) => {
        if (seen.has(item.stockItemId)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'stockItemId'],
            message: 'Each item can only be listed once. Add the quantities together.',
          });
        }
        seen.add(item.stockItemId);
      });
    }),
});
export type FulfilInput = z.infer<typeof fulfilSchema>;
