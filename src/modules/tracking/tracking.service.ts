import { timingSafeEqual } from 'node:crypto';
import { errors } from '../../utils/AppError';
import { type TrackedPrefix, findByReference } from './tracking.repository';
import type { TrackInput } from './tracking.schemas';

/**
 * "Track my request": a reference number plus the last 4 digits of the phone
 * number on the form. The reply holds what kind of submission it is, its
 * status and two dates, never a name, number, email or description.
 *
 * A wrong reference number and wrong digits get exactly the same reply, so
 * nobody can find out whether a reference number exists by guessing.
 */

type StatusInfo = { message: string; isFinal: boolean };

const KINDS: Record<
  TrackedPrefix,
  { type: string; typeLabel: string; statuses: Record<string, StatusInfo> }
> = {
  VOL: {
    type: 'volunteer_application',
    typeLabel: 'Volunteer application',
    statuses: {
      Submitted: {
        message: 'Your application has been received and is waiting for review.',
        isFinal: false,
      },
      Accepted: {
        message: 'Your application has been accepted. The team will contact you with the details.',
        isFinal: false,
      },
      Declined: {
        message: 'Your application was not accepted this time. Thank you for offering to help.',
        isFinal: true,
      },
      Attended: { message: 'Thank you for volunteering at this event.', isFinal: true },
      'Did not attend': {
        message: 'This event has passed. We hope to see you at a future event.',
        isFinal: true,
      },
    },
  },
  REQ: {
    type: 'assistance_request',
    typeLabel: 'Request for help',
    statuses: {
      Submitted: {
        message: 'Your request has been received and is waiting for review.',
        isFinal: false,
      },
      'Under review': { message: 'Our team is reviewing your request.', isFinal: false },
      Approved: {
        message: 'Your request has been approved. The team will contact you about the next steps.',
        isFinal: false,
      },
      Declined: {
        message: "We're unable to help with this request at the moment.",
        isFinal: true,
      },
      Fulfilled: { message: 'The help you asked for has been given.', isFinal: false },
      Closed: { message: 'This request is closed.', isFinal: true },
    },
  },
  PLG: {
    type: 'donation_pledge',
    typeLabel: 'Donation pledge',
    statuses: {
      Pending: {
        message: 'Your pledge has been received and is waiting for review.',
        isFinal: false,
      },
      Accepted: {
        message: 'Your pledge has been accepted. The team will contact you to arrange it.',
        isFinal: false,
      },
      Received: { message: 'Your donation has been received. Thank you!', isFinal: true },
      Declined: {
        message: "We're unable to accept this pledge at the moment. Thank you for offering.",
        isFinal: true,
      },
    },
  },
};

/** Every status each kind can have, for tests and documentation. */
export const TRACKED_STATUSES = Object.fromEntries(
  Object.entries(KINDS).map(([prefix, kind]) => [prefix, Object.keys(kind.statuses)]),
) as Record<TrackedPrefix, string[]>;

export type TrackingResult = {
  referenceNumber: string;
  type: string;
  typeLabel: string;
  status: string;
  statusMessage: string;
  isFinal: boolean;
  submittedAt: Date;
  lastUpdatedAt: Date;
};

export const NO_MATCH_MESSAGE =
  "We couldn't find a match. Please check your reference number and phone number.";

/**
 * Compares two 4-digit strings in constant time, so the time taken doesn't
 * hint at how many digits were right.
 */
export function sameLast4(typed: string, stored: string): boolean {
  const a = Buffer.from(typed.padStart(4, '-').slice(-4));
  const b = Buffer.from(stored.padStart(4, '-').slice(-4));
  return timingSafeEqual(a, b);
}

/** Stands in when there is no row, so a wrong reference costs the same as wrong digits. */
const NO_ROW_DIGITS = '----';

export async function track(input: TrackInput): Promise<TrackingResult> {
  const prefix = input.referenceNumber.slice(0, 3) as TrackedPrefix;
  const row = await findByReference(prefix, input.referenceNumber);
  const storedDigits = row ? row.contact_number.replace(/\D/g, '').slice(-4) : NO_ROW_DIGITS;
  const matches = sameLast4(input.phoneLast4, storedDigits);
  if (!row || !matches) throw errors.notFound(NO_MATCH_MESSAGE);

  const kind = KINDS[prefix];
  const info = kind.statuses[row.status] ?? { message: row.status, isFinal: false };
  return {
    referenceNumber: input.referenceNumber,
    type: kind.type,
    typeLabel: kind.typeLabel,
    status: row.status,
    statusMessage: info.message,
    isFinal: info.isFinal,
    submittedAt: row.submitted_date,
    lastUpdatedAt: row.last_updated,
  };
}
