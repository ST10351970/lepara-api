import { query } from '../../config/db';
import { FROM_DAY, TO_DAY } from '../../utils/sql';
import type { DateRange } from './reports.schemas';

/**
 * The SQL for the dashboard and the reports. Every count and total is worked
 * out by PostgreSQL (COUNT, SUM, AVG with FILTER and GROUP BY), never added up
 * in JavaScript. Empty date ranges give zeros: SUM and AVG are wrapped in
 * COALESCE, and percentages check for zero before dividing.
 *
 * Money: donation amounts are numeric(10,2) and come back as text such as
 * "1250.50"; order totals are bigint cents, also read as text. The service
 * turns both into cents.
 *
 * Dates are whole days in Johannesburg. $1 is always the first day and $2 the
 * last day of the range.
 */

const IN_RANGE = (column: string) => `${FROM_DAY(column, '$1')} AND ${TO_DAY(column, '$2')}`;

// --- Dashboard -------------------------------------------------------------------------------

export type DashboardRow = {
  requests_waiting: number;
  requests_submitted: number;
  requests_under_review: number;
  requests_approved: number;
  volunteers_waiting: number;
  pledges_waiting: number;
  pledges_to_receive: number;
  enquiries_new: number;
  low_stock_items: number;
  orders_awaiting_payment: number;
  orders_to_pack: number;
  orders_to_ship: number;
  orders_on_the_way: number;
  initiatives_upcoming: number;
  donation_count: number;
  monetary_count: number;
  monetary_total: string;
  goods_count: number;
};

/** $1 the first of this month, $2 today. */
export async function dashboardCounts(month: DateRange): Promise<DashboardRow> {
  const { rows } = await query<DashboardRow>(
    `SELECT
       (SELECT count(*) FROM assistance_request WHERE status IN ('Submitted', 'Under review'))::int
         AS requests_waiting,
       (SELECT count(*) FROM assistance_request WHERE status = 'Submitted')::int AS requests_submitted,
       (SELECT count(*) FROM assistance_request WHERE status = 'Under review')::int
         AS requests_under_review,
       (SELECT count(*) FROM assistance_request WHERE status = 'Approved')::int AS requests_approved,
       (SELECT count(*) FROM volunteer_application WHERE status = 'Submitted')::int
         AS volunteers_waiting,
       (SELECT count(*) FROM donation_pledge WHERE status = 'Pending')::int AS pledges_waiting,
       (SELECT count(*) FROM donation_pledge WHERE status = 'Accepted')::int AS pledges_to_receive,
       (SELECT count(*) FROM enquiry WHERE status = 'New')::int AS enquiries_new,
       (SELECT count(*) FROM stock_item WHERE quantity_on_hand <= reorder_level)::int
         AS low_stock_items,
       (SELECT count(*) FROM customer_order WHERE status = 'Pending payment')::int
         AS orders_awaiting_payment,
       (SELECT count(*) FROM customer_order WHERE status = 'Confirmed')::int AS orders_to_pack,
       (SELECT count(*) FROM customer_order WHERE status = 'Packed')::int AS orders_to_ship,
       (SELECT count(*) FROM customer_order WHERE status = 'Shipped')::int AS orders_on_the_way,
       (SELECT count(*) FROM initiative WHERE status = 'Published' AND end_date >= $2::date)::int
         AS initiatives_upcoming,
       d.donation_count, d.monetary_count, d.monetary_total, d.goods_count
     FROM (
       SELECT count(*)::int AS donation_count,
              count(*) FILTER (WHERE donation_type = 'Monetary')::int AS monetary_count,
              COALESCE(sum(amount), 0)::text AS monetary_total,
              count(*) FILTER (WHERE donation_type = 'Goods')::int AS goods_count
       FROM donation
       WHERE voided_at IS NULL AND date_received BETWEEN $1::date AND $2::date
     ) d`,
    [month.from, month.to],
  );
  return rows[0]!;
}

export type LowStockRow = {
  stock_item_id: number;
  item_name: string;
  unit_of_measure: string;
  quantity_on_hand: number;
  reorder_level: number;
};

/** The items furthest below their reorder level first. */
export async function lowStockItems(limit = 5): Promise<LowStockRow[]> {
  const { rows } = await query<LowStockRow>(
    `SELECT stock_item_id, item_name, unit_of_measure, quantity_on_hand, reorder_level
     FROM stock_item WHERE quantity_on_hand <= reorder_level
     ORDER BY quantity_on_hand - reorder_level, item_name
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// --- Donations ---------------------------------------------------------------------------------

export type DonationFilters = DateRange & { type?: 'Monetary' | 'Goods'; initiativeId?: number };

/** Donations received in the range ($1 to $2), not voided, with the optional filters $3 and $4. */
const DONATIONS_IN_RANGE = `
  SELECT * FROM donation
  WHERE voided_at IS NULL AND date_received BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR donation_type = $3)
    AND ($4::int IS NULL OR initiative_id = $4)`;

const donationValues = (filters: DonationFilters) => [
  filters.from,
  filters.to,
  filters.type ?? null,
  filters.initiativeId ?? null,
];

export type DonationSummaryRow = {
  donation_count: number;
  monetary_count: number;
  monetary_total: string;
  monetary_average: string;
  goods_count: number;
  donor_count: number;
};

export async function donationSummary(filters: DonationFilters): Promise<DonationSummaryRow> {
  const { rows } = await query<DonationSummaryRow>(
    `WITH d AS (${DONATIONS_IN_RANGE})
     SELECT count(*)::int AS donation_count,
            count(*) FILTER (WHERE donation_type = 'Monetary')::int AS monetary_count,
            COALESCE(sum(amount), 0)::text AS monetary_total,
            COALESCE(round(avg(amount), 2), 0)::text AS monetary_average,
            count(*) FILTER (WHERE donation_type = 'Goods')::int AS goods_count,
            count(DISTINCT lower(trim(donor_name)))::int AS donor_count
     FROM d`,
    donationValues(filters),
  );
  return rows[0]!;
}

export type DonationsByInitiativeRow = {
  initiative_id: number | null;
  title: string | null;
  donation_count: number;
  monetary_total: string;
  goods_count: number;
};

export async function donationsByInitiative(
  filters: DonationFilters,
): Promise<DonationsByInitiativeRow[]> {
  const { rows } = await query<DonationsByInitiativeRow>(
    `WITH d AS (${DONATIONS_IN_RANGE})
     SELECT d.initiative_id, i.title, count(*)::int AS donation_count,
            COALESCE(sum(d.amount), 0)::text AS monetary_total,
            count(*) FILTER (WHERE d.donation_type = 'Goods')::int AS goods_count
     FROM d LEFT JOIN initiative i ON i.initiative_id = d.initiative_id
     GROUP BY d.initiative_id, i.title
     ORDER BY i.title NULLS LAST, d.initiative_id`,
    donationValues(filters),
  );
  return rows;
}

export type GoodsByItemRow = {
  stock_item_id: number;
  item_name: string;
  unit_of_measure: string;
  quantity: number;
  donation_count: number;
};

export async function donatedGoodsByItem(filters: DonationFilters): Promise<GoodsByItemRow[]> {
  const { rows } = await query<GoodsByItemRow>(
    `WITH d AS (${DONATIONS_IN_RANGE})
     SELECT s.stock_item_id, s.item_name, s.unit_of_measure,
            sum(d.quantity)::int AS quantity, count(*)::int AS donation_count
     FROM d JOIN stock_item s ON s.stock_item_id = d.stock_item_id
     GROUP BY s.stock_item_id, s.item_name, s.unit_of_measure
     ORDER BY s.item_name`,
    donationValues(filters),
  );
  return rows;
}

export type DonationLineRow = {
  donation_id: number;
  date_received: string;
  donor_name: string;
  is_anonymous: boolean;
  donation_type: string;
  amount: string | null;
  item_name: string | null;
  quantity: number | null;
  unit_of_measure: string | null;
  initiative_title: string | null;
  receipt_reference: string | null;
  recorded_by: string;
};

/** Each donation, for the CSV. */
export async function donationLines(filters: DonationFilters): Promise<DonationLineRow[]> {
  const { rows } = await query<DonationLineRow>(
    `WITH d AS (${DONATIONS_IN_RANGE})
     SELECT d.donation_id, d.date_received::text AS date_received, d.donor_name, d.is_anonymous,
            d.donation_type, d.amount::text AS amount, s.item_name, d.quantity, s.unit_of_measure,
            i.title AS initiative_title, d.receipt_reference, a.full_name AS recorded_by
     FROM d
     LEFT JOIN stock_item s ON s.stock_item_id = d.stock_item_id
     LEFT JOIN initiative i ON i.initiative_id = d.initiative_id
     JOIN admin_user a ON a.admin_id = d.recorded_by
     ORDER BY d.date_received, d.donation_id`,
    donationValues(filters),
  );
  return rows;
}

// --- Stock ------------------------------------------------------------------------------------

export type StockReportRow = {
  stock_item_id: number;
  item_name: string;
  category: string | null;
  unit_of_measure: string;
  quantity_on_hand: number;
  reorder_level: number;
  is_low: boolean;
  opening: number;
  received: number;
  voided: number;
  given_out: number;
  adjusted: number;
  closing: number;
  movement_count: number;
};

/**
 * Each item's level now, and its movements in the range:
 *   opening + received − voided − given out + adjusted = closing
 * Closing is the level at the end of the last day; it is worked back from
 * today's level by undoing the movements made since then.
 */
export async function stockReport(range: DateRange): Promise<StockReportRow[]> {
  const inRange = IN_RANGE('m.movement_date');
  const signed = `CASE WHEN m.movement_type = 'Increase' THEN m.quantity ELSE -m.quantity END`;
  const { rows } = await query<StockReportRow>(
    `SELECT t.*,
            t.quantity_on_hand - t.change_after AS closing,
            t.quantity_on_hand - t.change_after
              - (t.received - t.voided - t.given_out + t.adjusted) AS opening
     FROM (
       SELECT s.stock_item_id, s.item_name, s.category, s.unit_of_measure, s.quantity_on_hand,
              s.reorder_level, (s.quantity_on_hand <= s.reorder_level) AS is_low,
              COALESCE(sum(m.quantity) FILTER (WHERE ${inRange} AND m.movement_type = 'Increase'
                AND m.donation_id IS NOT NULL), 0)::int AS received,
              COALESCE(sum(m.quantity) FILTER (WHERE ${inRange} AND m.movement_type = 'Decrease'
                AND m.donation_id IS NOT NULL), 0)::int AS voided,
              COALESCE(sum(m.quantity) FILTER (WHERE ${inRange} AND m.movement_type = 'Decrease'
                AND m.request_id IS NOT NULL), 0)::int AS given_out,
              COALESCE(sum(${signed}) FILTER (WHERE ${inRange} AND m.donation_id IS NULL
                AND m.request_id IS NULL), 0)::int AS adjusted,
              COALESCE(sum(${signed}) FILTER (WHERE m.movement_date >=
                (($2::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')), 0)::int
                AS change_after,
              count(m.movement_id) FILTER (WHERE ${inRange})::int AS movement_count
       FROM stock_item s LEFT JOIN stock_movement m ON m.stock_item_id = s.stock_item_id
       GROUP BY s.stock_item_id
     ) t
     ORDER BY t.item_name`,
    [range.from, range.to],
  );
  return rows;
}

// --- Assistance requests ---------------------------------------------------------------------

export type RequestCountsRow = {
  /** null on the last row: all types together. */
  request_type: string | null;
  total: number;
  submitted: number;
  under_review: number;
  approved: number;
  declined: number;
  fulfilled: number;
  closed: number;
  /** Of the requests decided, the % approved (including those since fulfilled or closed). */
  approved_percent: number;
};

/** Requests submitted in the range, by type and status; the last row is the total. */
export async function requestCounts(range: DateRange): Promise<RequestCountsRow[]> {
  const yes = `count(*) FILTER (WHERE status IN ('Approved', 'Fulfilled', 'Closed'))`;
  const decided = `count(*) FILTER (WHERE status IN ('Approved', 'Declined', 'Fulfilled', 'Closed'))`;
  const { rows } = await query<RequestCountsRow>(
    `SELECT request_type,
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'Submitted')::int AS submitted,
            count(*) FILTER (WHERE status = 'Under review')::int AS under_review,
            count(*) FILTER (WHERE status = 'Approved')::int AS approved,
            count(*) FILTER (WHERE status = 'Declined')::int AS declined,
            count(*) FILTER (WHERE status = 'Fulfilled')::int AS fulfilled,
            count(*) FILTER (WHERE status = 'Closed')::int AS closed,
            CASE WHEN ${decided} = 0 THEN 0
                 ELSE round(100.0 * ${yes} / ${decided}, 1) END::float8 AS approved_percent
     FROM assistance_request
     WHERE ${IN_RANGE('submitted_date')}
     GROUP BY ROLLUP (request_type)
     ORDER BY request_type NULLS LAST`,
    [range.from, range.to],
  );
  return rows;
}

// --- Initiatives and volunteers ------------------------------------------------------------------

const VOLUNTEER_COUNTS = `
  count(va.application_id)::int AS applications,
  count(va.application_id) FILTER (WHERE va.status = 'Submitted')::int AS waiting,
  count(va.application_id) FILTER (WHERE va.status IN ('Accepted', 'Attended', 'Did not attend'))::int
    AS accepted,
  count(va.application_id) FILTER (WHERE va.status = 'Attended')::int AS attended,
  count(va.application_id) FILTER (WHERE va.status = 'Did not attend')::int AS did_not_attend,
  count(va.application_id) FILTER (WHERE va.status = 'Declined')::int AS declined,
  CASE WHEN count(va.application_id) FILTER (WHERE va.status IN ('Attended', 'Did not attend')) = 0
       THEN 0
       ELSE round(100.0 * count(va.application_id) FILTER (WHERE va.status = 'Attended')
                  / count(va.application_id) FILTER (WHERE va.status IN ('Attended', 'Did not attend')), 1)
  END::float8 AS attendance_percent`;

export type VolunteerCounts = {
  applications: number;
  waiting: number;
  accepted: number;
  attended: number;
  did_not_attend: number;
  declined: number;
  /** Of the volunteers whose attendance was recorded, the % who came. */
  attendance_percent: number;
};

export type InitiativeReportRow = VolunteerCounts & {
  initiative_id: number;
  title: string;
  type_name: string;
  start_date: string;
  end_date: string;
  status: string;
  donation_count: number;
  monetary_total: string;
  goods_count: number;
};

const INITIATIVE_COLUMNS = `i.initiative_id, i.title, t.type_name, i.start_date::text AS start_date,
  i.end_date::text AS end_date, i.status, v.*, dn.donation_count, dn.monetary_total, dn.goods_count`;

const INITIATIVE_JOINS = `
  FROM initiative i
  JOIN initiative_type t ON t.initiative_type_id = i.initiative_type_id
  CROSS JOIN LATERAL (
    SELECT ${VOLUNTEER_COUNTS} FROM volunteer_application va WHERE va.initiative_id = i.initiative_id
  ) v
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS donation_count, COALESCE(sum(d.amount), 0)::text AS monetary_total,
           count(*) FILTER (WHERE d.donation_type = 'Goods')::int AS goods_count
    FROM donation d WHERE d.initiative_id = i.initiative_id AND d.voided_at IS NULL
  ) dn`;

/** Published or closed initiatives that run on any day in the range. */
export async function initiativesInRange(range: DateRange): Promise<InitiativeReportRow[]> {
  const { rows } = await query<InitiativeReportRow>(
    `SELECT ${INITIATIVE_COLUMNS} ${INITIATIVE_JOINS}
     WHERE i.status <> 'Draft' AND i.start_date <= $2::date AND i.end_date >= $1::date
     ORDER BY i.start_date, i.initiative_id`,
    [range.from, range.to],
  );
  return rows;
}

export async function initiativeTotals(initiativeId: number): Promise<InitiativeReportRow | null> {
  const { rows } = await query<InitiativeReportRow>(
    `SELECT ${INITIATIVE_COLUMNS} ${INITIATIVE_JOINS} WHERE i.initiative_id = $1`,
    [initiativeId],
  );
  return rows[0] ?? null;
}

export type TaskReportRow = VolunteerCounts & {
  task_id: number | null;
  task_name: string;
  volunteers_needed: number | null;
};

/** Volunteers per task, and a "No task chosen" row when some applications have none. */
export async function volunteersByTask(initiativeId: number): Promise<TaskReportRow[]> {
  const { rows } = await query<TaskReportRow>(
    `SELECT k.initiative_task_id AS task_id, k.task_name, k.volunteers_needed, ${VOLUNTEER_COUNTS}
     FROM initiative_task k
     LEFT JOIN volunteer_application va ON va.initiative_task_id = k.initiative_task_id
     WHERE k.initiative_id = $1
     GROUP BY k.initiative_task_id, k.task_name, k.volunteers_needed
     UNION ALL
     SELECT NULL, 'No task chosen', NULL, ${VOLUNTEER_COUNTS}
     FROM volunteer_application va
     WHERE va.initiative_id = $1 AND va.initiative_task_id IS NULL
     HAVING count(*) > 0
     ORDER BY task_id NULLS LAST, task_name`,
    [initiativeId],
  );
  return rows;
}

export async function initiativeGoods(initiativeId: number): Promise<GoodsByItemRow[]> {
  const { rows } = await query<GoodsByItemRow>(
    `SELECT s.stock_item_id, s.item_name, s.unit_of_measure,
            sum(d.quantity)::int AS quantity, count(*)::int AS donation_count
     FROM donation d JOIN stock_item s ON s.stock_item_id = d.stock_item_id
     WHERE d.initiative_id = $1 AND d.voided_at IS NULL
     GROUP BY s.stock_item_id, s.item_name, s.unit_of_measure
     ORDER BY s.item_name`,
    [initiativeId],
  );
  return rows;
}

export type PledgeCountsRow = {
  pending: number;
  accepted: number;
  received: number;
  declined: number;
};

export async function initiativePledges(initiativeId: number): Promise<PledgeCountsRow> {
  const { rows } = await query<PledgeCountsRow>(
    `SELECT count(*) FILTER (WHERE status = 'Pending')::int AS pending,
            count(*) FILTER (WHERE status = 'Accepted')::int AS accepted,
            count(*) FILTER (WHERE status = 'Received')::int AS received,
            count(*) FILTER (WHERE status = 'Declined')::int AS declined
     FROM donation_pledge WHERE initiative_id = $1`,
    [initiativeId],
  );
  return rows[0]!;
}

// --- Shop sales -------------------------------------------------------------------------------

export type SalesSummaryRow = {
  order_count: number;
  cancelled_count: number;
  active_count: number;
  items_sold: number;
  sales_total: string;
  goods_total: string;
  delivery_total: string;
  paid_total: string;
  unpaid_total: string;
  refunded_total: string;
  average_order: string;
  pending_payment: number;
  confirmed: number;
  packed: number;
  shipped: number;
  delivered: number;
};

/** Orders placed in the range. Cancelled orders are counted but not added to the sales. */
export async function salesSummary(range: DateRange): Promise<SalesSummaryRow> {
  const active = `o.status <> 'Cancelled'`;
  const { rows } = await query<SalesSummaryRow>(
    `SELECT count(*)::int AS order_count,
            count(*) FILTER (WHERE o.status = 'Cancelled')::int AS cancelled_count,
            count(*) FILTER (WHERE ${active})::int AS active_count,
            (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_item i
             JOIN customer_order x ON x.order_id = i.order_id
             WHERE x.status <> 'Cancelled' AND ${IN_RANGE('x.created_at')}) AS items_sold,
            COALESCE(sum(o.total_cents) FILTER (WHERE ${active}), 0)::text AS sales_total,
            COALESCE(sum(o.subtotal_cents) FILTER (WHERE ${active}), 0)::text AS goods_total,
            COALESCE(sum(o.delivery_cents) FILTER (WHERE ${active}), 0)::text AS delivery_total,
            COALESCE(sum(o.total_cents) FILTER (WHERE o.payment_status = 'Paid'), 0)::text
              AS paid_total,
            COALESCE(sum(o.total_cents) FILTER (WHERE ${active} AND o.payment_status = 'Unpaid'), 0)::text
              AS unpaid_total,
            COALESCE(sum(o.total_cents) FILTER (WHERE o.payment_status = 'Refunded'), 0)::text
              AS refunded_total,
            COALESCE(round(avg(o.total_cents) FILTER (WHERE ${active})), 0)::text AS average_order,
            count(*) FILTER (WHERE o.status = 'Pending payment')::int AS pending_payment,
            count(*) FILTER (WHERE o.status = 'Confirmed')::int AS confirmed,
            count(*) FILTER (WHERE o.status = 'Packed')::int AS packed,
            count(*) FILTER (WHERE o.status = 'Shipped')::int AS shipped,
            count(*) FILTER (WHERE o.status = 'Delivered')::int AS delivered
     FROM customer_order o
     WHERE ${IN_RANGE('o.created_at')}`,
    [range.from, range.to],
  );
  return rows[0]!;
}

export type SalesByMethodRow = { payment_method: string; order_count: number; total: string };

export async function salesByPaymentMethod(range: DateRange): Promise<SalesByMethodRow[]> {
  const { rows } = await query<SalesByMethodRow>(
    `SELECT o.payment_method, count(*)::int AS order_count,
            COALESCE(sum(o.total_cents), 0)::text AS total
     FROM customer_order o
     WHERE o.status <> 'Cancelled' AND ${IN_RANGE('o.created_at')}
     GROUP BY o.payment_method
     ORDER BY o.payment_method`,
    [range.from, range.to],
  );
  return rows;
}

export type SalesByProductRow = {
  product_name: string;
  size: string;
  units_sold: number;
  sales: string;
};

/** What sold, by the name and size copied onto each order line. */
export async function salesByProduct(range: DateRange): Promise<SalesByProductRow[]> {
  const { rows } = await query<SalesByProductRow>(
    `SELECT i.product_name, i.size, sum(i.quantity)::int AS units_sold,
            sum(i.line_total_cents)::text AS sales
     FROM order_item i JOIN customer_order o ON o.order_id = i.order_id
     WHERE o.status <> 'Cancelled' AND ${IN_RANGE('o.created_at')}
     GROUP BY i.product_name, i.size
     ORDER BY units_sold DESC, i.product_name,
              array_position(ARRAY['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size'], i.size::text)`,
    [range.from, range.to],
  );
  return rows;
}

export type SalesOrderRow = {
  order_number: string;
  placed_at: string;
  customer_name: string;
  status: string;
  payment_method: string;
  payment_status: string;
  item_count: number;
  subtotal: string;
  delivery: string;
  total: string;
};

/** Each order, for the CSV. */
export async function salesOrders(range: DateRange): Promise<SalesOrderRow[]> {
  const { rows } = await query<SalesOrderRow>(
    `SELECT o.order_number,
            to_char(o.created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS placed_at,
            c.first_name || ' ' || c.last_name AS customer_name, o.status, o.payment_method,
            o.payment_status,
            (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_item i
             WHERE i.order_id = o.order_id) AS item_count,
            o.subtotal_cents::text AS subtotal, o.delivery_cents::text AS delivery,
            o.total_cents::text AS total
     FROM customer_order o JOIN customer c ON c.customer_id = o.customer_id
     WHERE ${IN_RANGE('o.created_at')}
     ORDER BY o.created_at, o.order_id`,
    [range.from, range.to],
  );
  return rows;
}
