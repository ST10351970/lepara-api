import { type Queryable, query } from '../../config/db';
import { FROM_DAY, PHONE_MATCH, TO_DAY, pickSort, searchPatterns } from '../../utils/sql';
import type { AdminOrderListQuery } from './adminOrders.schemas';

/**
 * Queries for the dashboard's orders. Values always go in as $1, $2, ...
 * Sort orders come only from the fixed list below (pickSort).
 * Bigint money columns come back as text and are turned into numbers here.
 */

export type AdminOrderRow = {
  orderId: number;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  customerMobile: string;
  customerDeleted: boolean;
  recipientName: string;
  city: string;
  itemCount: number;
  totalCents: number;
  courierReference: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const LIST_COLUMNS = `o.order_id AS "orderId", o.order_number AS "orderNumber", o.status,
  o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
  c.customer_id AS "customerId", c.first_name || ' ' || c.last_name AS "customerName",
  c.email AS "customerEmail", c.mobile AS "customerMobile",
  (c.deleted_at IS NOT NULL) AS "customerDeleted",
  o.recipient_name AS "recipientName", o.city,
  (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_item i
   WHERE i.order_id = o.order_id) AS "itemCount",
  o.total_cents::text AS "totalCents", o.courier_reference AS "courierReference",
  o.created_at AS "createdAt", o.updated_at AS "updatedAt"`;

const FROM_ORDERS = 'FROM customer_order o JOIN customer c ON c.customer_id = o.customer_id';

const SORTS = {
  newest: 'o.created_at DESC, o.order_id DESC',
  oldest: 'o.created_at ASC, o.order_id ASC',
  updated: 'o.updated_at DESC, o.order_id DESC',
};

const withNumbers = (row: AdminOrderRow & { totalCents: unknown }): AdminOrderRow => ({
  ...row,
  totalCents: Number(row.totalCents),
});

/**
 * Orders for the dashboard. `search` looks in the order number, the customer's
 * name and email, the recipient's name and both phone numbers.
 */
export async function listOrders(
  filters: AdminOrderListQuery,
  page: { limit: number; offset: number },
): Promise<{ rows: AdminOrderRow[]; total: number }> {
  const { text, phone } = searchPatterns(filters.search);
  const where = `($1::text = 'all' OR o.status = $1)
    AND ($2::text IS NULL OR o.payment_status = $2)
    AND ($3::text IS NULL OR o.payment_method = $3)
    AND ${FROM_DAY('o.created_at', '$4')}
    AND ${TO_DAY('o.created_at', '$5')}
    AND ($6::text IS NULL OR o.order_number ILIKE $6 OR o.recipient_name ILIKE $6
         OR (c.first_name || ' ' || c.last_name) ILIKE $6 OR c.email ILIKE $6
         OR ${PHONE_MATCH('o.phone', '$7')} OR ${PHONE_MATCH('c.mobile', '$7')})`;
  const values = [
    filters.status,
    filters.paymentStatus ?? null,
    filters.paymentMethod ?? null,
    filters.from ?? null,
    filters.to ?? null,
    text,
    phone,
  ];
  const [list, count] = await Promise.all([
    query<AdminOrderRow>(
      `SELECT ${LIST_COLUMNS} ${FROM_ORDERS}
       WHERE ${where}
       ORDER BY ${pickSort(filters.sort, SORTS, 'newest')}
       LIMIT $8 OFFSET $9`,
      [...values, page.limit, page.offset],
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total ${FROM_ORDERS} WHERE ${where}`, values),
  ]);
  return { rows: list.rows.map(withNumbers), total: count.rows[0]?.total ?? 0 };
}

export async function findOrderSummary(
  db: Queryable,
  orderId: number,
): Promise<AdminOrderRow | null> {
  const { rows } = await query<AdminOrderRow>(
    `SELECT ${LIST_COLUMNS} ${FROM_ORDERS} WHERE o.order_id = $1`,
    [orderId],
    db,
  );
  return rows[0] ? withNumbers(rows[0]) : null;
}

export type AdminHistoryRow = {
  status: string;
  note: string | null;
  at: Date;
  changedBy: number | null;
  changedByName: string | null;
};

/** Each status change with the admin who made it (null: the customer or the system). */
export async function findHistory(db: Queryable, orderId: number): Promise<AdminHistoryRow[]> {
  const { rows } = await query<AdminHistoryRow>(
    `SELECT h.status, h.note, h.changed_at AS at, h.changed_by AS "changedBy",
       a.full_name AS "changedByName"
     FROM order_status_history h LEFT JOIN admin_user a ON a.admin_id = h.changed_by
     WHERE h.order_id = $1
     ORDER BY h.changed_at, h.history_id`,
    [orderId],
    db,
  );
  return rows;
}

export type PaymentRow = {
  paymentId: number;
  provider: string;
  reference: string | null;
  amountCents: number;
  status: string;
  receivedAt: Date;
  recordedBy: number | null;
  recordedByName: string | null;
};

export async function findPayments(db: Queryable, orderId: number): Promise<PaymentRow[]> {
  const { rows } = await query<PaymentRow & { amountCents: string }>(
    `SELECT p.payment_id AS "paymentId", p.provider, p.provider_reference AS reference,
       p.amount_cents::text AS "amountCents", p.status, p.received_at AS "receivedAt",
       p.recorded_by AS "recordedBy", a.full_name AS "recordedByName"
     FROM payment p LEFT JOIN admin_user a ON a.admin_id = p.recorded_by
     WHERE p.order_id = $1
     ORDER BY p.received_at, p.payment_id`,
    [orderId],
    db,
  );
  return rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
}

// --- Changes ----------------------------------------------------------------------------------

export type LockedOrder = {
  orderId: number;
  orderNumber: string;
  customerId: number;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  totalCents: number;
};

/** Locks the order until the transaction ends, so two admins can't change it at once. */
export async function lockOrder(db: Queryable, orderId: number): Promise<LockedOrder | null> {
  const { rows } = await query<LockedOrder & { totalCents: string }>(
    `SELECT order_id AS "orderId", order_number AS "orderNumber", customer_id AS "customerId",
       status, payment_method AS "paymentMethod", payment_status AS "paymentStatus",
       total_cents::text AS "totalCents"
     FROM customer_order WHERE order_id = $1
     FOR UPDATE`,
    [orderId],
    db,
  );
  const row = rows[0];
  return row ? { ...row, totalCents: Number(row.totalCents) } : null;
}

/** Moves the order to a new status (and courier reference, cancel reason or payment status). */
export async function updateOrder(
  db: Queryable,
  orderId: number,
  changes: {
    status?: string;
    paymentStatus?: string;
    courierReference?: string;
    cancelReason?: string;
  },
): Promise<void> {
  await query(
    `UPDATE customer_order
     SET status = COALESCE($2, status),
         payment_status = COALESCE($3, payment_status),
         courier_reference = COALESCE($4, courier_reference),
         cancel_reason = COALESCE($5, cancel_reason),
         updated_at = now()
     WHERE order_id = $1`,
    [
      orderId,
      changes.status ?? null,
      changes.paymentStatus ?? null,
      changes.courierReference ?? null,
      changes.cancelReason ?? null,
    ],
    db,
  );
}

export async function insertPayment(
  db: Queryable,
  payment: {
    orderId: number;
    provider: 'Manual EFT' | 'Cash on delivery';
    reference: string | null;
    amountCents: number;
    recordedBy: number;
  },
): Promise<number> {
  const { rows } = await query<{ paymentId: number }>(
    `INSERT INTO payment (order_id, provider, provider_reference, amount_cents, status, recorded_by)
     VALUES ($1, $2, $3, $4, 'Complete', $5)
     RETURNING payment_id AS "paymentId"`,
    [payment.orderId, payment.provider, payment.reference, payment.amountCents, payment.recordedBy],
    db,
  );
  return rows[0]!.paymentId;
}
