import { errors } from '../../utils/AppError';
import { type CsvValue, rands, toCsv } from '../../utils/csv';
import { todayInJohannesburg } from '../../utils/dates';
import { formatRand, numericToCents } from '../../utils/money';
import { paymentMethodLabel } from '../orders/orders.format';
import { ASSISTANCE_REQUEST_TYPE_VALUES } from '../submissions/submissions.options';
import * as repo from './reports.repository';
import type {
  GoodsByItemRow,
  InitiativeReportRow,
  RequestCountsRow,
  VolunteerCounts,
} from './reports.repository';
import type { DateRange, DonationReportQuery } from './reports.schemas';
import { monthStart } from './reports.schemas';

/**
 * The dashboard and the reports for the website (build guide step 19), matching
 * the Reporting Component in Task 1 Section 6.3: donations received over a
 * period, current stock levels, assistance requests by status and volunteer
 * participation per initiative, plus the shop's sales.
 *
 * The numbers all come from SQL (see the repository); this file only renames
 * them for the website and lays them out as CSV. Amounts are given in cents
 * (for sums) and as labels like "R1 250.50" (for the screen).
 */

const money = (cents: number) => ({ cents, label: formatRand(cents) });
const fromNumeric = (value: string) => money(numericToCents(value));
const fromBigint = (value: string) => money(Number(value));

// --- Dashboard ---------------------------------------------------------------------------------

export async function dashboard() {
  const today = todayInJohannesburg();
  const month = { from: monthStart(today), to: today };
  const [counts, lowItems] = await Promise.all([
    repo.dashboardCounts(month),
    repo.lowStockItems(5),
  ]);
  return {
    today,
    assistanceRequests: {
      waitingForDecision: counts.requests_waiting,
      submitted: counts.requests_submitted,
      underReview: counts.requests_under_review,
      approvedToFulfil: counts.requests_approved,
    },
    volunteerApplications: { waiting: counts.volunteers_waiting },
    donationPledges: { waiting: counts.pledges_waiting, toReceive: counts.pledges_to_receive },
    enquiries: { new: counts.enquiries_new },
    stock: {
      lowItemCount: counts.low_stock_items,
      lowItems: lowItems.map((item) => ({
        stockItemId: item.stock_item_id,
        itemName: item.item_name,
        unit: item.unit_of_measure,
        quantityOnHand: item.quantity_on_hand,
        reorderLevel: item.reorder_level,
      })),
    },
    orders: {
      awaitingPayment: counts.orders_awaiting_payment,
      toPack: counts.orders_to_pack,
      toShip: counts.orders_to_ship,
      onTheWay: counts.orders_on_the_way,
    },
    initiatives: { upcoming: counts.initiatives_upcoming },
    donationsThisMonth: {
      ...month,
      count: counts.donation_count,
      monetaryCount: counts.monetary_count,
      monetaryTotal: fromNumeric(counts.monetary_total),
      goodsCount: counts.goods_count,
    },
  };
}

// --- Donations ---------------------------------------------------------------------------------

const goodsItem = (row: GoodsByItemRow) => ({
  stockItemId: row.stock_item_id,
  itemName: row.item_name,
  unit: row.unit_of_measure,
  quantity: row.quantity,
  donationCount: row.donation_count,
});

export async function donationReport(filters: DonationReportQuery) {
  const [summary, byInitiative, goods] = await Promise.all([
    repo.donationSummary(filters),
    repo.donationsByInitiative(filters),
    repo.donatedGoodsByItem(filters),
  ]);
  return {
    range: { from: filters.from, to: filters.to },
    filters: { type: filters.type ?? null, initiativeId: filters.initiativeId ?? null },
    summary: {
      donationCount: summary.donation_count,
      donorCount: summary.donor_count,
      monetaryCount: summary.monetary_count,
      monetaryTotal: fromNumeric(summary.monetary_total),
      monetaryAverage: fromNumeric(summary.monetary_average),
      goodsCount: summary.goods_count,
    },
    byInitiative: byInitiative.map((row) => ({
      initiativeId: row.initiative_id,
      title: row.title ?? 'General (no initiative)',
      donationCount: row.donation_count,
      monetaryTotal: fromNumeric(row.monetary_total),
      goodsCount: row.goods_count,
    })),
    goodsByItem: goods.map(goodsItem),
  };
}

export async function donationReportCsv(filters: DonationReportQuery): Promise<string> {
  const rows = await repo.donationLines(filters);
  return toCsv(
    [
      'Date received',
      'Donor',
      'Anonymous',
      'Type',
      'Amount (R)',
      'Item',
      'Quantity',
      'Unit',
      'Initiative',
      'Receipt reference',
      'Recorded by',
    ],
    rows.map((row): CsvValue[] => [
      row.date_received,
      row.donor_name,
      row.is_anonymous,
      row.donation_type,
      row.amount === null ? null : rands(numericToCents(row.amount)),
      row.item_name,
      row.quantity,
      row.unit_of_measure,
      row.initiative_title ?? 'General',
      row.receipt_reference,
      row.recorded_by,
    ]),
  );
}

// --- Stock -------------------------------------------------------------------------------------

export async function stockReport(range: DateRange) {
  const rows = await repo.stockReport(range);
  return {
    range,
    summary: {
      itemCount: rows.length,
      lowItemCount: rows.filter((row) => row.is_low).length,
    },
    items: rows.map((row) => ({
      stockItemId: row.stock_item_id,
      itemName: row.item_name,
      category: row.category,
      unit: row.unit_of_measure,
      quantityOnHand: row.quantity_on_hand,
      reorderLevel: row.reorder_level,
      isLow: row.is_low,
      /** In the range: opening + received − voided − givenOut + adjusted = closing. */
      opening: row.opening,
      received: row.received,
      voided: row.voided,
      givenOut: row.given_out,
      adjusted: row.adjusted,
      closing: row.closing,
      movementCount: row.movement_count,
    })),
  };
}

export async function stockReportCsv(range: DateRange): Promise<string> {
  const rows = await repo.stockReport(range);
  return toCsv(
    [
      'Item',
      'Category',
      'Unit',
      `Opening (${range.from})`,
      'Received from donations',
      'Removed by voided donations',
      'Given out',
      'Adjusted',
      `Closing (${range.to})`,
      'On hand now',
      'Reorder level',
      'Low stock',
    ],
    rows.map((row): CsvValue[] => [
      row.item_name,
      row.category,
      row.unit_of_measure,
      row.opening,
      row.received,
      row.voided,
      row.given_out,
      row.adjusted,
      row.closing,
      row.quantity_on_hand,
      row.reorder_level,
      row.is_low,
    ]),
  );
}

// --- Assistance requests -------------------------------------------------------------------------

const requestCounts = (row: RequestCountsRow) => ({
  total: row.total,
  submitted: row.submitted,
  underReview: row.under_review,
  approved: row.approved,
  declined: row.declined,
  fulfilled: row.fulfilled,
  closed: row.closed,
  approvedPercent: row.approved_percent,
});

/** Every request type gets a row, with zeros when none came in. */
async function requestRows(range: DateRange) {
  const rows = await repo.requestCounts(range);
  const all = rows.find((row) => row.request_type === null)!;
  const byType = new Map(
    rows.filter((row) => row.request_type !== null).map((row) => [row.request_type!, row]),
  );
  const types = [
    ...ASSISTANCE_REQUEST_TYPE_VALUES,
    ...[...byType.keys()].filter(
      (type) => !(ASSISTANCE_REQUEST_TYPE_VALUES as readonly string[]).includes(type),
    ),
  ];
  const zero: RequestCountsRow = {
    request_type: null,
    total: 0,
    submitted: 0,
    under_review: 0,
    approved: 0,
    declined: 0,
    fulfilled: 0,
    closed: 0,
    approved_percent: 0,
  };
  return {
    all,
    types: types.map((type) => ({ type, row: byType.get(type) ?? zero })),
  };
}

export async function requestReport(range: DateRange) {
  const { all, types } = await requestRows(range);
  return {
    range,
    total: requestCounts(all),
    byType: types.map(({ type, row }) => ({ requestType: type, ...requestCounts(row) })),
  };
}

export async function requestReportCsv(range: DateRange): Promise<string> {
  const { all, types } = await requestRows(range);
  const line = (label: string, row: RequestCountsRow): CsvValue[] => [
    label,
    row.total,
    row.submitted,
    row.under_review,
    row.approved,
    row.declined,
    row.fulfilled,
    row.closed,
    row.approved_percent,
  ];
  return toCsv(
    [
      'Request type',
      'Total',
      'Submitted',
      'Under review',
      'Approved',
      'Declined',
      'Fulfilled',
      'Closed',
      'Approved % of decided',
    ],
    [...types.map(({ type, row }) => line(type, row)), line('All types', all)],
  );
}

// --- Initiatives and volunteers --------------------------------------------------------------------

const volunteers = (row: VolunteerCounts) => ({
  applications: row.applications,
  waiting: row.waiting,
  accepted: row.accepted,
  attended: row.attended,
  didNotAttend: row.did_not_attend,
  declined: row.declined,
  attendancePercent: row.attendance_percent,
});

const initiativeLine = (row: InitiativeReportRow) => ({
  initiativeId: row.initiative_id,
  title: row.title,
  type: row.type_name,
  startDate: row.start_date,
  endDate: row.end_date,
  status: row.status,
  volunteers: volunteers(row),
  donations: {
    count: row.donation_count,
    monetaryTotal: fromNumeric(row.monetary_total),
    goodsCount: row.goods_count,
  },
});

const VOLUNTEER_HEADERS = [
  'Applications',
  'Waiting',
  'Accepted',
  'Attended',
  'Did not attend',
  'Declined',
  'Attendance %',
];
const volunteerCells = (row: VolunteerCounts): CsvValue[] => [
  row.applications,
  row.waiting,
  row.accepted,
  row.attended,
  row.did_not_attend,
  row.declined,
  row.attendance_percent,
];

export async function initiativesReport(range: DateRange) {
  const rows = await repo.initiativesInRange(range);
  return { range, initiatives: rows.map(initiativeLine) };
}

export async function initiativesReportCsv(range: DateRange): Promise<string> {
  const rows = await repo.initiativesInRange(range);
  return toCsv(
    [
      'Initiative',
      'Type',
      'Start date',
      'End date',
      'Status',
      ...VOLUNTEER_HEADERS,
      'Donations',
      'Money donated (R)',
      'Goods donations',
    ],
    rows.map((row): CsvValue[] => [
      row.title,
      row.type_name,
      row.start_date,
      row.end_date,
      row.status,
      ...volunteerCells(row),
      row.donation_count,
      rands(numericToCents(row.monetary_total)),
      row.goods_count,
    ]),
  );
}

async function initiativeData(initiativeId: number) {
  const totals = await repo.initiativeTotals(initiativeId);
  if (!totals) throw errors.notFound("We couldn't find that initiative.");
  const [tasks, goods, pledges] = await Promise.all([
    repo.volunteersByTask(initiativeId),
    repo.initiativeGoods(initiativeId),
    repo.initiativePledges(initiativeId),
  ]);
  return { totals, tasks, goods, pledges };
}

/** Everything recorded for one initiative, whatever the date. */
export async function initiativeReport(initiativeId: number) {
  const { totals, tasks, goods, pledges } = await initiativeData(initiativeId);
  const line = initiativeLine(totals);
  return {
    initiative: {
      initiativeId: line.initiativeId,
      title: line.title,
      type: line.type,
      startDate: line.startDate,
      endDate: line.endDate,
      status: line.status,
    },
    volunteers: line.volunteers,
    byTask: tasks.map((task) => ({
      taskId: task.task_id,
      taskName: task.task_name,
      volunteersNeeded: task.volunteers_needed,
      ...volunteers(task),
    })),
    donations: { ...line.donations, goodsByItem: goods.map(goodsItem) },
    pledges,
  };
}

export async function initiativeReportCsv(initiativeId: number): Promise<string> {
  const { totals, tasks } = await initiativeData(initiativeId);
  return toCsv(
    ['Task', 'Volunteers needed', ...VOLUNTEER_HEADERS],
    [
      ...tasks.map((task): CsvValue[] => [
        task.task_name,
        task.volunteers_needed,
        ...volunteerCells(task),
      ]),
      ['All tasks', null, ...volunteerCells(totals)],
    ],
  );
}

// --- Shop sales -----------------------------------------------------------------------------------

export async function salesReport(range: DateRange) {
  const [summary, methods, products] = await Promise.all([
    repo.salesSummary(range),
    repo.salesByPaymentMethod(range),
    repo.salesByProduct(range),
  ]);
  return {
    range,
    summary: {
      orderCount: summary.order_count,
      cancelledCount: summary.cancelled_count,
      activeOrderCount: summary.active_count,
      itemsSold: summary.items_sold,
      salesTotal: fromBigint(summary.sales_total),
      goodsTotal: fromBigint(summary.goods_total),
      deliveryTotal: fromBigint(summary.delivery_total),
      paidTotal: fromBigint(summary.paid_total),
      unpaidTotal: fromBigint(summary.unpaid_total),
      refundedTotal: fromBigint(summary.refunded_total),
      averageOrder: fromBigint(summary.average_order),
    },
    byStatus: {
      'Pending payment': summary.pending_payment,
      Confirmed: summary.confirmed,
      Packed: summary.packed,
      Shipped: summary.shipped,
      Delivered: summary.delivered,
      Cancelled: summary.cancelled_count,
    },
    byPaymentMethod: methods.map((row) => ({
      paymentMethod: row.payment_method,
      label: paymentMethodLabel(row.payment_method),
      orderCount: row.order_count,
      total: fromBigint(row.total),
    })),
    products: products.map((row) => ({
      productName: row.product_name,
      size: row.size,
      unitsSold: row.units_sold,
      sales: fromBigint(row.sales),
    })),
  };
}

export async function salesReportCsv(range: DateRange): Promise<string> {
  const rows = await repo.salesOrders(range);
  return toCsv(
    [
      'Order number',
      'Placed',
      'Customer',
      'Status',
      'Payment method',
      'Payment status',
      'Items',
      'Subtotal (R)',
      'Delivery (R)',
      'Total (R)',
    ],
    rows.map((row): CsvValue[] => [
      row.order_number,
      row.placed_at,
      row.customer_name,
      row.status,
      paymentMethodLabel(row.payment_method),
      row.payment_status,
      row.item_count,
      rands(Number(row.subtotal)),
      rands(Number(row.delivery)),
      rands(Number(row.total)),
    ]),
  );
}
