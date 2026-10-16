import { z } from 'zod';
import { isoDate, pagination, searchText } from '../../schemas/common';
import {
  ASSISTANCE_REQUEST_TYPE_VALUES,
  DONATION_CATEGORY_VALUES,
  ENQUIRY_TYPE_VALUES,
} from '../submissions/submissions.options';

/**
 * What the review queues accept. List filters that can't be understood are
 * ignored (the full list is shown) rather than failing; decisions are checked
 * strictly, with a message for each field.
 */

export const VOLUNTEER_STATUSES = [
  'Submitted',
  'Accepted',
  'Declined',
  'Attended',
  'Did not attend',
] as const;
export const REQUEST_STATUSES = [
  'Submitted',
  'Under review',
  'Approved',
  'Declined',
  'Fulfilled',
  'Closed',
] as const;
export const PLEDGE_STATUSES = ['Pending', 'Accepted', 'Received', 'Declined'] as const;
export const ENQUIRY_STATUSES = ['New', 'Reviewed'] as const;

// --- Lists -------------------------------------------------------------------------------

function statusFilter<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.union([z.enum(values), z.literal('all')]).catch('all');
}

function choiceFilter<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.enum(values).optional().catch(undefined);
}

const optionalId = z.coerce
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .optional()
  .catch(undefined);

/** YYYY-MM-DD, a day in Johannesburg; anything else is ignored. */
const optionalDate = isoDate.optional().catch(undefined);

/** Checked against each list's own allowed sort orders (see the repository). */
const sort = z.string().optional().catch(undefined);

const common = pagination.extend({
  from: optionalDate,
  to: optionalDate,
  search: searchText,
  sort,
});

/** GET /admin/volunteer-applications */
export const volunteerListQuery = common.extend({
  status: statusFilter(VOLUNTEER_STATUSES),
  initiativeId: optionalId,
  taskId: optionalId,
});
export type VolunteerListQuery = z.infer<typeof volunteerListQuery>;

/** GET /admin/assistance-requests */
export const requestListQuery = common.extend({
  status: statusFilter(REQUEST_STATUSES),
  requestType: choiceFilter(ASSISTANCE_REQUEST_TYPE_VALUES),
});
export type RequestListQuery = z.infer<typeof requestListQuery>;

/** GET /admin/donation-pledges */
export const pledgeListQuery = common.extend({
  status: statusFilter(PLEDGE_STATUSES),
  category: choiceFilter(DONATION_CATEGORY_VALUES),
  initiativeId: optionalId,
});
export type PledgeListQuery = z.infer<typeof pledgeListQuery>;

/** GET /admin/enquiries */
export const enquiryListQuery = common.extend({
  status: statusFilter(ENQUIRY_STATUSES),
  enquiryType: choiceFilter(ENQUIRY_TYPE_VALUES),
});
export type EnquiryListQuery = z.infer<typeof enquiryListQuery>;

// --- Decisions ---------------------------------------------------------------------------

const DECLINE_REASON_MESSAGE =
  'Please give a reason for declining (at least 3 characters). The person will see it in their email.';

function listOf(values: readonly string[]): string {
  return values.length === 1
    ? values[0]!
    : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

/** { status, reason? }. The reason is required to decline and is used only then. */
function decisionSchema<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z
    .object({
      status: z.enum(values, { error: `Please choose ${listOf(values)}.` }),
      reason: z
        .string({ error: 'Please write the reason as text.' })
        .trim()
        .max(500, 'Please keep the reason under 500 characters.')
        .optional(),
    })
    .superRefine((body, ctx) => {
      if (body.status === 'Declined' && (body.reason ?? '').length < 3) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: DECLINE_REASON_MESSAGE });
      }
    });
}

/** PATCH /admin/volunteer-applications/:id/decision */
export const volunteerDecisionSchema = decisionSchema([
  'Accepted',
  'Declined',
  'Attended',
  'Did not attend',
] as const);
export type VolunteerDecision = z.infer<typeof volunteerDecisionSchema>;

/** PATCH /admin/assistance-requests/:id/decision. Fulfilled comes from step 13's fulfilment. */
export const requestDecisionSchema = decisionSchema(['Approved', 'Declined', 'Closed'] as const);
export type RequestDecision = z.infer<typeof requestDecisionSchema>;

/** PATCH /admin/donation-pledges/:id/status. Received comes from step 13's receive. */
export const pledgeDecisionSchema = decisionSchema(['Accepted', 'Declined'] as const);
export type PledgeDecision = z.infer<typeof pledgeDecisionSchema>;

/** PATCH /admin/enquiries/:id/status */
export const enquiryStatusSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES, { error: 'Please choose New or Reviewed.' }),
});
export type EnquiryStatusInput = z.infer<typeof enquiryStatusSchema>;
