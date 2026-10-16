import { query } from '../../config/db';

/**
 * Looks up a submission by its reference number. The table name comes only
 * from the fixed list below, never from what someone typed.
 */

export const TRACKED_TABLES = {
  VOL: 'volunteer_application',
  REQ: 'assistance_request',
  PLG: 'donation_pledge',
} as const;

export type TrackedPrefix = keyof typeof TRACKED_TABLES;

export type TrackedRow = {
  status: string;
  submitted_date: Date;
  /** When an admin last decided on it, or when it was sent if nobody has yet. */
  last_updated: Date;
  contact_number: string;
};

export async function findByReference(
  prefix: TrackedPrefix,
  referenceNumber: string,
): Promise<TrackedRow | null> {
  const table = TRACKED_TABLES[prefix];
  const { rows } = await query<TrackedRow>(
    `SELECT status, submitted_date, COALESCE(reviewed_date, submitted_date) AS last_updated,
            contact_number
     FROM ${table}
     WHERE reference_number = $1`,
    [referenceNumber],
  );
  return rows[0] ?? null;
}
