import { type Queryable, pool, withTransaction } from '../../config/db';
import { sendEmailInBackground } from '../../services/email';
import {
  orderCancelledByUs,
  orderDelivered,
  orderPacked,
  orderPaymentReceived,
  orderShipped,
} from '../../services/emailTemplates';
import { orderStatusChanged } from '../../services/notifications';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { formatPrice, formatRand } from '../../utils/money';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import { constraintOf } from '../../utils/pgErrors';
import type { PageMeta } from '../../utils/respond';
import * as adminRepo from './adminOrders.repository';
import type { AdminOrderRow, LockedOrder } from './adminOrders.repository';
import type {
  AdminOrderListQuery,
  OrderPaymentInput,
  OrderStatusInput,
} from './adminOrders.schemas';
import { paymentMethodLabel, statusLabel } from './orders.format';
import * as ordersRepo from './orders.repository';
import { toCustomerOrder } from './orders.service';
import { adminCanCancel, nextStatus, statusRefusal } from './orders.transitions';

/**
 * Order management for the dashboard (build guide step 16). Any signed-in admin.
 *
 *  - Status moves only forward, one step at a time: Confirmed → Packed → Shipped →
 *    Delivered. Shipped needs a courier reference.
 *  - An EFT order waits as Pending payment until its payment is recorded, which
 *    confirms it. The amount must equal the order total.
 *  - Cancelling needs a reason and puts the stock back. A paid order is only
 *    cancelled once the admin confirms the money was paid back (refunded: true).
 *  - Every change adds a status history row (where the status changes), an audit
 *    row and an email to the customer, and later a push notification (step 17).
 */

const orderNotFound = () => errors.notFound("We couldn't find that order.");

// --- What the dashboard receives -------------------------------------------------------------

export type AdminOrderListItem = {
  orderId: number;
  orderNumber: string;
  status: string;
  statusLabel: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  paymentStatus: string;
  customer: {
    customerId: number;
    name: string;
    email: string;
    mobile: string;
    accountDeleted: boolean;
  };
  recipientName: string;
  city: string;
  itemCount: number;
  totalCents: number;
  total: string;
  courierReference: string | null;
  placedAt: Date;
  updatedAt: Date;
};

export type AdminOrderDetail = AdminOrderListItem & {
  items: ReturnType<typeof toCustomerOrder>['items'];
  subtotalCents: number;
  subtotal: string;
  deliveryFeeCents: number;
  deliveryFee: string;
  deliveryAddress: ReturnType<typeof toCustomerOrder>['deliveryAddress'];
  cancelReason: string | null;
  history: Array<{
    status: string;
    label: string;
    at: Date;
    note: string | null;
    changedBy: { adminId: number; name: string | null } | null;
  }>;
  payments: Array<{
    paymentId: number;
    provider: string;
    reference: string | null;
    amountCents: number;
    amount: string;
    status: string;
    receivedAt: Date;
    recordedBy: { adminId: number; name: string | null } | null;
  }>;
  /** What the dashboard's buttons may offer for this order right now. */
  actions: {
    nextStatus: string | null;
    canCancel: boolean;
    /** A paid order: cancelling it needs refunded: true. */
    cancelNeedsRefund: boolean;
    canRecordPayment: boolean;
  };
};

function toListItem(row: AdminOrderRow): AdminOrderListItem {
  return {
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    status: row.status,
    statusLabel: statusLabel(row.status),
    paymentMethod: row.paymentMethod,
    paymentMethodLabel: paymentMethodLabel(row.paymentMethod),
    paymentStatus: row.paymentStatus,
    customer: {
      customerId: row.customerId,
      name: row.customerName,
      email: row.customerEmail,
      mobile: row.customerMobile,
      accountDeleted: row.customerDeleted,
    },
    recipientName: row.recipientName,
    city: row.city,
    itemCount: row.itemCount,
    totalCents: row.totalCents,
    total: formatPrice(row.totalCents),
    courierReference: row.courierReference,
    placedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Which payments can be recorded: EFT while it waits, cash on delivery any time before paid. */
function canRecordPayment(order: { status: string; paymentMethod: string; paymentStatus: string }) {
  if (order.paymentStatus !== 'Unpaid' || order.status === 'Cancelled') return false;
  if (order.paymentMethod === 'EFT') return order.status === 'Pending payment';
  return order.paymentMethod === 'Cash on delivery';
}

async function buildDetail(db: Queryable, orderId: number): Promise<AdminOrderDetail | null> {
  const summary = await adminRepo.findOrderSummary(db, orderId);
  if (!summary) return null;
  const [detail, history, payments] = await Promise.all([
    ordersRepo.findOrderDetail(db, { orderId }),
    adminRepo.findHistory(db, orderId),
    adminRepo.findPayments(db, orderId),
  ]);
  const order = toCustomerOrder(detail!, null);
  const next = nextStatus(summary.status);
  return {
    ...toListItem(summary),
    items: order.items,
    subtotalCents: order.subtotalCents,
    subtotal: order.subtotal,
    deliveryFeeCents: order.deliveryFeeCents,
    deliveryFee: order.deliveryFee,
    deliveryAddress: order.deliveryAddress,
    cancelReason: order.cancelReason,
    history: history.map((entry) => ({
      status: entry.status,
      label: statusLabel(entry.status),
      at: entry.at,
      note: entry.note,
      changedBy:
        entry.changedBy === null ? null : { adminId: entry.changedBy, name: entry.changedByName },
    })),
    payments: payments.map((payment) => ({
      paymentId: payment.paymentId,
      provider: payment.provider,
      reference: payment.reference,
      amountCents: payment.amountCents,
      amount: formatRand(payment.amountCents),
      status: payment.status,
      receivedAt: payment.receivedAt,
      recordedBy:
        payment.recordedBy === null
          ? null
          : { adminId: payment.recordedBy, name: payment.recordedByName },
    })),
    actions: {
      // An EFT order waiting for payment has no next step: recording the payment confirms it.
      nextStatus: next,
      canCancel: adminCanCancel(summary.status),
      cancelNeedsRefund: adminCanCancel(summary.status) && summary.paymentStatus === 'Paid',
      canRecordPayment: canRecordPayment(summary),
    },
  };
}

// --- Reading ------------------------------------------------------------------------------------

/** GET /admin/orders */
export async function listOrders(
  filters: AdminOrderListQuery,
): Promise<{ orders: AdminOrderListItem[]; meta: PageMeta }> {
  const { rows, total } = await adminRepo.listOrders(
    filters,
    pageToLimitOffset(filters.page, filters.pageSize),
  );
  return { orders: rows.map(toListItem), meta: pageMeta(filters.page, filters.pageSize, total) };
}

/** GET /admin/orders/:id */
export async function getOrder(orderId: number): Promise<AdminOrderDetail> {
  const order = await buildDetail(pool, orderId);
  if (!order) throw orderNotFound();
  return order;
}

// --- Telling the customer -----------------------------------------------------------------------

type Change = {
  order: LockedOrder;
  status: string;
  courierReference?: string;
  reason?: string;
  refunded?: boolean;
  payment?: { amount: string };
};

/** After the change is saved: the email, then the push notification. Neither can undo it. */
async function tellCustomer(change: Change): Promise<void> {
  const { order } = change;
  const buyer = await ordersRepo.findBuyer(pool, order.customerId).catch(() => null);
  const total = formatPrice(order.totalCents);
  if (buyer) {
    const to = { to: buyer.email, name: buyer.firstName, orderNumber: order.orderNumber };
    const method = order.paymentMethod as 'EFT' | 'Cash on delivery';
    if (change.payment) {
      sendEmailInBackground(
        orderPaymentReceived({ ...to, amount: change.payment.amount, paymentMethod: method }),
        'order-payment-received',
      );
    } else if (change.status === 'Packed') {
      sendEmailInBackground(orderPacked(to), 'order-packed');
    } else if (change.status === 'Shipped') {
      const cashDue = method === 'Cash on delivery' && order.paymentStatus === 'Unpaid';
      sendEmailInBackground(
        orderShipped({
          ...to,
          courierReference: change.courierReference!,
          cashDue: cashDue ? total : null,
        }),
        'order-shipped',
      );
    } else if (change.status === 'Delivered') {
      sendEmailInBackground(orderDelivered(to), 'order-delivered');
    } else if (change.status === 'Cancelled') {
      sendEmailInBackground(
        orderCancelledByUs({
          ...to,
          reason: change.reason!,
          refunded: change.refunded ? total : null,
        }),
        'order-cancelled-by-us',
      );
    }
  }

  // A payment for cash on delivery doesn't change the status, so there's no notification.
  if (change.payment && change.status === order.status) return;
  try {
    await orderStatusChanged({
      customerId: order.customerId,
      orderNumber: order.orderNumber,
      status: change.status,
      title: `Order ${order.orderNumber}: ${statusLabel(change.status)}`,
      body:
        change.status === 'Shipped'
          ? `Your order is on the way. Courier reference: ${change.courierReference}.`
          : `Your order is now: ${statusLabel(change.status)}.`,
    });
  } catch (error) {
    logger.warn({ err: error }, 'Could not send the order notification');
  }
}

// --- Changing the status ----------------------------------------------------------------------

/** PATCH /admin/orders/:id/status */
export async function changeStatus(
  adminId: number,
  orderId: number,
  input: OrderStatusInput,
): Promise<AdminOrderDetail> {
  const { detail, change } = await withTransaction(async (client) => {
    const order = await adminRepo.lockOrder(client, orderId);
    if (!order) throw orderNotFound();
    const refusal = statusRefusal(order.status, input.status);
    if (refusal) throw errors.conflict(refusal);

    const change: Change = { order, status: input.status };
    if (input.status === 'Cancelled') {
      const paid = order.paymentStatus === 'Paid';
      if (paid && input.refunded !== true) {
        const message =
          `This order has been paid (${formatRand(order.totalCents)}). Pay the money back to ` +
          'the customer first, then cancel it with refunded set to true.';
        throw new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'refunded', message }]);
      }
      // The stock goes back, sizes locked in the usual order.
      const quantities = await ordersRepo.orderQuantities(client, orderId);
      await ordersRepo.lockVariants(
        client,
        quantities.map((line) => line.variantId),
      );
      await ordersRepo.changeStock(
        client,
        quantities.map((line) => ({ variantId: line.variantId, change: line.quantity })),
      );
      await adminRepo.updateOrder(client, orderId, {
        status: 'Cancelled',
        cancelReason: input.reason!,
        paymentStatus: paid ? 'Refunded' : undefined,
      });
      await ordersRepo.addStatusHistory(client, orderId, 'Cancelled', {
        changedBy: adminId,
        note: paid ? 'Cancelled by us, and the payment was refunded' : 'Cancelled by us',
      });
      change.reason = input.reason!;
      change.refunded = paid;
    } else {
      const shipped = input.status === 'Shipped';
      await adminRepo.updateOrder(client, orderId, {
        status: input.status,
        courierReference: shipped ? input.courierReference! : undefined,
      });
      await ordersRepo.addStatusHistory(client, orderId, input.status, {
        changedBy: adminId,
        note: shipped ? `Courier reference: ${input.courierReference}` : null,
      });
      if (shipped) change.courierReference = input.courierReference!;
    }

    await recordAudit(
      {
        adminId,
        action: `order_${input.status.toLowerCase()}`,
        tableName: 'customer_order',
        recordId: orderId,
        details: {
          orderNumber: order.orderNumber,
          from: order.status,
          to: input.status,
          ...(change.courierReference ? { courierReference: change.courierReference } : {}),
          ...(change.reason ? { reason: change.reason, refunded: change.refunded } : {}),
        },
      },
      client,
    );
    return { detail: (await buildDetail(client, orderId))!, change };
  });

  await tellCustomer(change);
  return detail;
}

// --- Recording a payment -----------------------------------------------------------------------

/** PATCH /admin/orders/:id/payment: an EFT that arrived, or cash collected on delivery. */
export async function recordPayment(
  adminId: number,
  orderId: number,
  input: OrderPaymentInput,
): Promise<AdminOrderDetail> {
  try {
    const { detail, change } = await withTransaction(async (client) => {
      const order = await adminRepo.lockOrder(client, orderId);
      if (!order) throw orderNotFound();
      if (order.status === 'Cancelled') {
        throw errors.conflict("This order was cancelled, so it can't be marked as paid.");
      }
      if (order.paymentStatus !== 'Unpaid') {
        throw errors.conflict('This order is already marked as paid.');
      }
      if (!canRecordPayment(order)) {
        throw errors.conflict("This order's payment can't be recorded here.");
      }
      if (input.amount !== order.totalCents) {
        const message = `The amount must equal the order total of ${formatRand(order.totalCents)}.`;
        throw errors.validation([{ field: 'amount', message }], message);
      }

      const eft = order.paymentMethod === 'EFT';
      const reference = input.reference ?? (eft ? order.orderNumber : null);
      await adminRepo.insertPayment(client, {
        orderId,
        provider: eft ? 'Manual EFT' : 'Cash on delivery',
        reference,
        amountCents: order.totalCents,
        recordedBy: adminId,
      });
      if (eft) {
        // The payment confirms an EFT order.
        await adminRepo.updateOrder(client, orderId, {
          status: 'Confirmed',
          paymentStatus: 'Paid',
        });
        await ordersRepo.addStatusHistory(client, orderId, 'Confirmed', {
          changedBy: adminId,
          note: 'EFT payment received',
        });
      } else {
        await adminRepo.updateOrder(client, orderId, { paymentStatus: 'Paid' });
      }
      await recordAudit(
        {
          adminId,
          action: 'order_payment_recorded',
          tableName: 'customer_order',
          recordId: orderId,
          details: {
            orderNumber: order.orderNumber,
            paymentMethod: order.paymentMethod,
            amountCents: order.totalCents,
            reference,
          },
        },
        client,
      );
      const change: Change = {
        order,
        status: eft ? 'Confirmed' : order.status,
        payment: { amount: formatRand(order.totalCents) },
      };
      return { detail: (await buildDetail(client, orderId))!, change };
    });
    await tellCustomer(change);
    return detail;
  } catch (error) {
    if (constraintOf(error) === 'payment_provider_reference_key') {
      const message = 'This reference was already recorded for another payment.';
      throw new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'reference', message }]);
    }
    throw error;
  }
}
