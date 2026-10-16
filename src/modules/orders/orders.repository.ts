import { type Queryable, query } from '../../config/db';
import type { VariantForSale } from './orders.pricing';

/**
 * Queries for the cart and orders. Every customer query includes the
 * customer's own ID, so one customer can never read or change another's order.
 * Money columns that are bigint come back from PostgreSQL as text and are
 * turned into numbers here.
 */

// --- Sizes for sale -----------------------------------------------------------------

const VARIANT_COLUMNS = `v.variant_id AS "variantId", v.product_id AS "productId", v.size,
  v.quantity_on_hand AS "quantityOnHand", p.name AS "productName", p.price_cents AS "priceCents",
  p.is_active AS "isActive", p.image_url AS "imageUrl"`;

/**
 * The sizes in a cart with their product's current name and price.
 * With lock: true, each size's row is locked until the transaction ends, in
 * variant ID order (the same order everywhere, so two orders can't deadlock).
 * A second order for the same last item waits here, then sees the new count.
 */
export async function findVariantsForSale(
  db: Queryable,
  variantIds: number[],
  { lock }: { lock: boolean },
): Promise<Map<number, VariantForSale>> {
  const { rows } = await query<VariantForSale>(
    `SELECT ${VARIANT_COLUMNS}
     FROM product_variant v JOIN product p ON p.product_id = v.product_id
     WHERE v.variant_id = ANY($1::int[])
     ORDER BY v.variant_id
     ${lock ? 'FOR UPDATE OF v' : ''}`,
    [variantIds],
    db,
  );
  return new Map(rows.map((row) => [row.variantId, row]));
}

/** Locks sizes before stock goes back on them (cancelling), in the same order as above. */
export async function lockVariants(db: Queryable, variantIds: number[]): Promise<void> {
  await query(
    `SELECT 1 FROM product_variant WHERE variant_id = ANY($1::int[])
     ORDER BY variant_id FOR UPDATE`,
    [variantIds],
    db,
  );
}

/** Adds (positive) or takes away (negative) stock. The database refuses to go below zero. */
export async function changeStock(
  db: Queryable,
  changes: Array<{ variantId: number; change: number }>,
): Promise<void> {
  await query(
    `UPDATE product_variant v
     SET quantity_on_hand = v.quantity_on_hand + c.change
     FROM unnest($1::int[], $2::int[]) AS c(variant_id, change)
     WHERE v.variant_id = c.variant_id`,
    [changes.map((c) => c.variantId), changes.map((c) => c.change)],
    db,
  );
}

// --- The customer ---------------------------------------------------------------------

export type Buyer = { firstName: string; email: string };

/**
 * Locks the customer's row while one of their orders is placed, so their
 * orders are placed one at a time (the open-orders limit can't be raced).
 * NO KEY UPDATE still lets other tables link to the customer meanwhile.
 */
export async function lockBuyer(db: Queryable, customerId: number): Promise<Buyer | null> {
  const { rows } = await query<Buyer>(
    `SELECT first_name AS "firstName", email FROM customer
     WHERE customer_id = $1 AND is_active AND deleted_at IS NULL
     FOR NO KEY UPDATE`,
    [customerId],
    db,
  );
  return rows[0] ?? null;
}

/** The name and email for an order email (no lock). */
export async function findBuyer(db: Queryable, customerId: number): Promise<Buyer | null> {
  const { rows } = await query<Buyer>(
    `SELECT first_name AS "firstName", email FROM customer
     WHERE customer_id = $1 AND is_active AND deleted_at IS NULL`,
    [customerId],
    db,
  );
  return rows[0] ?? null;
}

/** Orders still waiting for payment or delivery that haven't been paid. */
export async function countOpenUnpaidOrders(db: Queryable, customerId: number): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM customer_order
     WHERE customer_id = $1 AND payment_status = 'Unpaid'
       AND status IN ('Pending payment', 'Confirmed', 'Packed', 'Shipped')`,
    [customerId],
    db,
  );
  return rows[0]!.n;
}

// --- Placing an order ---------------------------------------------------------------

export type NewOrder = {
  customerId: number;
  status: string;
  paymentMethod: string;
  recipientName: string;
  streetAddress: string;
  city: string;
  postalCode: string;
  phone: string;
  subtotalCents: number;
  deliveryCents: number;
  totalCents: number;
};

/** The order number comes from the database sequence: LAFM-1001, LAFM-1002, ... */
export async function insertOrder(
  db: Queryable,
  order: NewOrder,
): Promise<{ orderId: number; orderNumber: string }> {
  const { rows } = await query<{ orderId: number; orderNumber: string }>(
    `INSERT INTO customer_order (customer_id, status, payment_method, recipient_name,
       street_address, city, postal_code, phone, subtotal_cents, delivery_cents, total_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING order_id AS "orderId", order_number AS "orderNumber"`,
    [
      order.customerId,
      order.status,
      order.paymentMethod,
      order.recipientName,
      order.streetAddress,
      order.city,
      order.postalCode,
      order.phone,
      order.subtotalCents,
      order.deliveryCents,
      order.totalCents,
    ],
    db,
  );
  return rows[0]!;
}

export type NewOrderItem = {
  variantId: number;
  productName: string;
  size: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

/** The name, size and price are copied, so later changes never alter a past order. */
export async function insertOrderItems(
  db: Queryable,
  orderId: number,
  items: NewOrderItem[],
): Promise<void> {
  await query(
    `INSERT INTO order_item (order_id, variant_id, product_name, size, unit_price_cents,
       quantity, line_total_cents)
     SELECT $1, i.variant_id, i.product_name, i.size, i.unit_price_cents, i.quantity, i.line_total
     FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::int[], $7::bigint[])
       WITH ORDINALITY
       AS i(variant_id, product_name, size, unit_price_cents, quantity, line_total, n)
     ORDER BY i.n`,
    [
      orderId,
      items.map((item) => item.variantId),
      items.map((item) => item.productName),
      items.map((item) => item.size),
      items.map((item) => item.unitPriceCents),
      items.map((item) => item.quantity),
      items.map((item) => item.lineTotalCents),
    ],
    db,
  );
}

/** One row per status change: the Orders tab shows each step with its time. */
export async function addStatusHistory(
  db: Queryable,
  orderId: number,
  status: string,
  { changedBy = null, note = null }: { changedBy?: number | null; note?: string | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by, note)
     VALUES ($1, $2, $3, $4)`,
    [orderId, status, changedBy, note],
    db,
  );
}

// --- Reading orders -------------------------------------------------------------------

export type OrderRow = {
  orderId: number;
  orderNumber: string;
  customerId: number;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  recipientName: string;
  streetAddress: string;
  city: string;
  postalCode: string;
  phone: string;
  subtotalCents: number;
  deliveryCents: number;
  totalCents: number;
  courierReference: string | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderItemRow = {
  variantId: number;
  productId: number;
  productName: string;
  size: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  imageUrl: string | null;
};

export type HistoryRow = { status: string; note: string | null; at: Date };

export type OrderDetailRow = OrderRow & { items: OrderItemRow[]; history: HistoryRow[] };

const ORDER_COLUMNS = `o.order_id AS "orderId", o.order_number AS "orderNumber",
  o.customer_id AS "customerId", o.status, o.payment_method AS "paymentMethod",
  o.payment_status AS "paymentStatus", o.recipient_name AS "recipientName",
  o.street_address AS "streetAddress", o.city, o.postal_code AS "postalCode", o.phone,
  o.subtotal_cents::text AS "subtotalCents", o.delivery_cents::text AS "deliveryCents",
  o.total_cents::text AS "totalCents", o.courier_reference AS "courierReference",
  o.cancel_reason AS "cancelReason", o.created_at AS "createdAt", o.updated_at AS "updatedAt"`;

function toOrderRow(row: Record<string, unknown>): OrderRow {
  return {
    ...(row as OrderRow),
    subtotalCents: Number(row.subtotalCents),
    deliveryCents: Number(row.deliveryCents),
    totalCents: Number(row.totalCents),
  };
}

/** One order with its lines and status history, or null. */
export async function findOrderDetail(
  db: Queryable,
  where: { customerId: number; orderNumber: string } | { orderId: number },
): Promise<OrderDetailRow | null> {
  const [condition, values] =
    'orderId' in where
      ? ['o.order_id = $1', [where.orderId]]
      : ['o.customer_id = $1 AND o.order_number = $2', [where.customerId, where.orderNumber]];
  const { rows } = await query(
    `SELECT ${ORDER_COLUMNS} FROM customer_order o WHERE ${condition}`,
    values,
    db,
  );
  const order = rows[0];
  if (!order) return null;
  const orderId = order.orderId as number;
  const [items, history] = await Promise.all([
    query<OrderItemRow & { lineTotalCents: string }>(
      `SELECT i.variant_id AS "variantId", v.product_id AS "productId",
         i.product_name AS "productName", i.size, i.unit_price_cents AS "unitPriceCents",
         i.quantity, i.line_total_cents::text AS "lineTotalCents", p.image_url AS "imageUrl"
       FROM order_item i
       JOIN product_variant v ON v.variant_id = i.variant_id
       JOIN product p ON p.product_id = v.product_id
       WHERE i.order_id = $1
       ORDER BY i.order_item_id`,
      [orderId],
      db,
    ),
    query<HistoryRow>(
      `SELECT status, note, changed_at AS at FROM order_status_history
       WHERE order_id = $1 ORDER BY changed_at, history_id`,
      [orderId],
      db,
    ),
  ]);
  return {
    ...toOrderRow(order),
    items: items.rows.map((item) => ({ ...item, lineTotalCents: Number(item.lineTotalCents) })),
    history: history.rows,
  };
}

export type OrderSummaryRow = {
  orderNumber: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  totalCents: number;
  createdAt: Date;
  itemCount: number;
  firstItem: { name: string; size: string; imageUrl: string | null } | null;
};

/** The customer's orders, newest first. */
export async function listCustomerOrders(
  customerId: number,
  page: { limit: number; offset: number },
): Promise<{ rows: OrderSummaryRow[]; total: number }> {
  const [list, count] = await Promise.all([
    query<OrderSummaryRow & { totalCents: string }>(
      `SELECT o.order_number AS "orderNumber", o.status, o.payment_method AS "paymentMethod",
         o.payment_status AS "paymentStatus", o.total_cents::text AS "totalCents",
         o.created_at AS "createdAt",
         (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_item i
          WHERE i.order_id = o.order_id) AS "itemCount",
         (SELECT json_build_object('name', i.product_name, 'size', i.size, 'imageUrl', p.image_url)
          FROM order_item i
          JOIN product_variant v ON v.variant_id = i.variant_id
          JOIN product p ON p.product_id = v.product_id
          WHERE i.order_id = o.order_id
          ORDER BY i.order_item_id LIMIT 1) AS "firstItem"
       FROM customer_order o
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC, o.order_id DESC
       LIMIT $2 OFFSET $3`,
      [customerId, page.limit, page.offset],
    ),
    query<{ total: number }>(
      'SELECT count(*)::int AS total FROM customer_order WHERE customer_id = $1',
      [customerId],
    ),
  ]);
  return {
    rows: list.rows.map((row) => ({ ...row, totalCents: Number(row.totalCents) })),
    total: count.rows[0]?.total ?? 0,
  };
}

// --- Cancelling -------------------------------------------------------------------------

/** Locks one of the customer's orders until the transaction ends. */
export async function lockCustomerOrder(
  db: Queryable,
  customerId: number,
  orderNumber: string,
): Promise<{ orderId: number; status: string; paymentStatus: string } | null> {
  const { rows } = await query<{ orderId: number; status: string; paymentStatus: string }>(
    `SELECT order_id AS "orderId", status, payment_status AS "paymentStatus"
     FROM customer_order WHERE customer_id = $1 AND order_number = $2
     FOR UPDATE`,
    [customerId, orderNumber],
    db,
  );
  return rows[0] ?? null;
}

export async function orderQuantities(
  db: Queryable,
  orderId: number,
): Promise<Array<{ variantId: number; quantity: number }>> {
  const { rows } = await query<{ variantId: number; quantity: number }>(
    `SELECT variant_id AS "variantId", sum(quantity)::int AS quantity
     FROM order_item WHERE order_id = $1 GROUP BY variant_id ORDER BY variant_id`,
    [orderId],
    db,
  );
  return rows;
}

export async function markCancelled(
  db: Queryable,
  orderId: number,
  reason: string | null,
): Promise<void> {
  await query(
    `UPDATE customer_order SET status = 'Cancelled', cancel_reason = $2, updated_at = now()
     WHERE order_id = $1`,
    [orderId, reason],
    db,
  );
}
