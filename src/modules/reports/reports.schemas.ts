import { z } from 'zod';
import { isoDate } from '../../schemas/common';
import { todayInJohannesburg } from '../../utils/dates';

/**
 * What the reports accept. Dates are whole days in Johannesburg, YYYY-MM-DD.
 * Without dates, a report covers this month so far. `from` must be on or
 * before `to`. Add format=csv to download the report as a spreadsheet.
 */

export type DateRange = { from: string; to: string };

const format = z.enum(['json', 'csv']).catch('json');

/** The first day of the month that `day` falls in. */
export const monthStart = (day: string) => `${day.slice(0, 8)}01`;

function withDefaults<T extends { from?: string; to?: string }>(query: T, today: string) {
  const from = query.from ?? monthStart(today);
  // Only a start date: up to today, or that one day if it is in the future.
  const to = query.to ?? (from > today ? from : today);
  return { ...query, from, to };
}

const rangeShape = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  format,
};

function checkOrder(range: { from: string; to: string }, ctx: z.RefinementCtx) {
  if (range.from > range.to) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'The end date must be on or after the start date.',
    });
  }
}

/** ?from=&to=&format= */
export const rangeQuery = z
  .object(rangeShape)
  .transform((query) => withDefaults(query, todayInJohannesburg()))
  .superRefine(checkOrder);
export type RangeQuery = z.infer<typeof rangeQuery>;

/** GET /admin/reports/donations?from=&to=&type=&initiativeId=&format= */
export const donationReportQuery = z
  .object({
    ...rangeShape,
    type: z.enum(['Monetary', 'Goods']).optional().catch(undefined),
    initiativeId: z.coerce
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .optional()
      .catch(undefined),
  })
  .transform((query) => withDefaults(query, todayInJohannesburg()))
  .superRefine(checkOrder);
export type DonationReportQuery = z.infer<typeof donationReportQuery>;

/** GET /admin/reports/initiatives/:id?format= (all of the initiative's records, no dates) */
export const formatQuery = z.object({ format });
export type FormatQuery = z.infer<typeof formatQuery>;
