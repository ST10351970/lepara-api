import { type Queryable, pool, query } from '../../config/db';
import { likeContains, pickSort } from '../../utils/sql';

/**
 * Queries for recorded donations. Values always go in as $1, $2, ...; sort
 * orders come only from the fixed list below. Donations are never deleted:
 * a mistake is voided, which keeps the record and reverses its stock.
 */

export type DonationRow = {
  donation_id: number;
  donation_type: 'Monetary' | 'Goods';
  donor_name: string;
  is_anonymous: boolean;
  /** numeric(10,2) text, e.g. "250.00" */
  amount: string | null;
  receipt_reference: string | null;
  stock_item_id: number | null;
  item_name: string | null;
  unit_of_measure: string | null;
  quantity: number | null;
  initiative_id: number | null;
  initiative_title: string | null;
  pledge_id: number | null;
  pledge_reference: string | null;
  date_received: string;
  recorded_by: number;
  recorded_by_name: string;
  voided_at: Date | null;
  voided_by: number | null;
  voided_by_name: string | null;
  void_reason: string | null;
};

const DONATION_SELECT = `SELECT d.donation_id, d.donation_type, d.donor_name, d.is_anonymous,
    d.amount::text AS amount, d.receipt_reference, d.stock_item_id, s.item_name,
    s.unit_of_measure, d.quantity, d.initiative_id, i.title AS initiative_title, d.pledge_id,
    p.reference_number AS pledge_reference, d.date_received::text AS date_received,
    d.recorded_by, r.full_name AS recorded_by_name,
    d.voided_at, d.voided_by, v.full_name AS voided_by_name, d.void_reason
  FROM donation d
  JOIN admin_user r ON r.admin_id = d.recorded_by
  LEFT JOIN admin_user v ON v.admin_id = d.voided_by
  LEFT JOIN stock_item s ON s.stock_item_id = d.stock_item_id
  LEFT JOIN initiative i ON i.initiative_id = d.initiative_id
  LEFT JOIN donation_pledge p ON p.pledge_id = d.pledge_id`;

const DONATION_SORTS = {
  newest: 'd.date_received DESC, d.donation_id DESC',
  oldest: 'd.date_received ASC, d.donation_id ASC',
  donor: 'd.donor_name ASC, d.donation_id DESC',
  amount: 'd.amount DESC NULLS LAST, d.donation_id DESC',
};
export const DONATION_SORT_KEYS = Object.keys(DONATION_SORTS);

export async function listDonations(filters: {
  type?: string;
  status: 'active' | 'voided' | 'all';
  initiativeId?: number;
  stockItemId?: number;
  from?: string;
  to?: string;
  search?: string;
  sort?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: DonationRow[]; total: number }> {
  const where = `($1::text IS NULL OR d.donation_type = $1)
    AND ($2::text = 'all' OR ($2::text = 'voided') = (d.voided_at IS NOT NULL))
    AND ($3::int IS NULL OR d.initiative_id = $3)
    AND ($4::int IS NULL OR d.stock_item_id = $4)
    AND ($5::date IS NULL OR d.date_received >= $5::date)
    AND ($6::date IS NULL OR d.date_received <= $6::date)
    AND ($7::text IS NULL OR d.donor_name ILIKE $7 OR d.receipt_reference ILIKE $7)`;
  const values = [
    filters.type ?? null,
    filters.status,
    filters.initiativeId ?? null,
    filters.stockItemId ?? null,
    filters.from ?? null,
    filters.to ?? null,
    filters.search ? likeContains(filters.search) : null,
  ];
  const [page, count] = await Promise.all([
    query<DonationRow>(
      `${DONATION_SELECT} WHERE ${where}
       ORDER BY ${pickSort(filters.sort, DONATION_SORTS, 'newest')}
       LIMIT $8 OFFSET $9`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM donation d WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function findDonation(
  donationId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<DonationRow | null> {
  const { rows } = await query<DonationRow>(
    `${DONATION_SELECT} WHERE d.donation_id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`,
    [donationId],
    db,
  );
  return rows[0] ?? null;
}

export async function initiativeExists(db: Queryable, initiativeId: number): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM initiative WHERE initiative_id = $1',
    [initiativeId],
    db,
  );
  return rows.length === 1;
}

export async function insertDonation(
  db: Queryable,
  values: {
    adminId: number;
    type: 'Monetary' | 'Goods';
    donorName: string;
    isAnonymous: boolean;
    initiativeId: number | null;
    /** numeric(10,2) text */
    amount: string | null;
    receiptReference: string | null;
    stockItemId: number | null;
    quantity: number | null;
    dateReceived: string;
    pledgeId: number | null;
  },
): Promise<number> {
  const { rows } = await query<{ donation_id: number }>(
    `INSERT INTO donation (recorded_by, donation_type, donor_name, is_anonymous, initiative_id,
                           amount, receipt_reference, stock_item_id, quantity, date_received,
                           pledge_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING donation_id`,
    [
      values.adminId,
      values.type,
      values.donorName,
      values.isAnonymous,
      values.initiativeId,
      values.amount,
      values.receiptReference,
      values.stockItemId,
      values.quantity,
      values.dateReceived,
      values.pledgeId,
    ],
    db,
  );
  return rows[0]!.donation_id;
}

export async function markVoided(
  db: Queryable,
  donationId: number,
  adminId: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE donation SET voided_at = now(), voided_by = $2, void_reason = $3
     WHERE donation_id = $1`,
    [donationId, adminId, reason],
    db,
  );
}
