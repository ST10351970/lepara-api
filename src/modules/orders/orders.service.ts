import { pool, withTransaction } from '../../config/db';
import { type Env, env } from '../../config/env';
import {
  type IdempotencyClaim,
  type StoredResponse,
  claimIdempotencyKey,
  saveIdempotentResponse,
} from '../../middleware/idempotency';
import { sendEmailInBackground } from '../../services/email';
import { type BankDetails, orderCancelled, orderPlaced } from '../../services/emailTemplates';
import { errors } from '../../utils/AppError';
import { formatPrice } from '../../utils/money';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import type { PageMeta } from '../../utils/respond';
import {
  FIRST_STATUS,
  PAYMENT_METHOD_OPTIONS,
  type TrackingStep,
  customerCanCancel,
  paymentMethodLabel,
  statusLabel,
  statusMessage,
  trackingSteps,
} from './orders.format';
import { type PricedCart, cartConflict, priceCart } from './orders.pricing';
import * as repo from './orders.repository';
import type { OrderDetailRow, OrderSummaryRow } from './orders.repository';
import type {
  CancelOrderInput,
  MyOrdersQuery,
  PlaceOrderInput,
  QuoteInput,
} from './orders.schemas';

/**
 * The cart and orders (build guide step 15).
 *
 *  - The cart lives on the phone. The server only prices it (quote) and places it (order),
 *    both with priceCart(), so the two totals always match.
 *  - Placing an order is one transaction: lock the customer, claim the Idempotency-Key, lock
 *    the sizes, check stock, price from the database, save the order, its lines and its first
 *    status, take the stock, store the reply for repeats, commit. Then the email goes out.
 *  - EFT orders start as "Pending payment" with the order number as the bank reference;
 *    cash-on-delivery orders start as "Confirmed".
 *  - A customer can cancel an unpaid order until it is packed; the stock goes back.
 */

/** Unpaid orders a customer may have open at once, so nobody can hold all the stock. */
export const MAX_OPEN_ORDERS = 3;

const orderNotFound = () => errors.notFound("We couldn't find that order.");

/** The NGO's bank account for EFT, when all four EFT_ settings are filled in. */
export function bankDetails(
  source: Pick<
    Env,
    'EFT_BANK_NAME' | 'EFT_ACCOUNT_NAME' | 'EFT_ACCOUNT_NUMBER' | 'EFT_BRANCH_CODE'
  > = env,
): BankDetails | null {
  const { EFT_BANK_NAME, EFT_ACCOUNT_NAME, EFT_ACCOUNT_NUMBER, EFT_BRANCH_CODE } = source;
  if (!EFT_BANK_NAME || !EFT_ACCOUNT_NAME || !EFT_ACCOUNT_NUMBER || !EFT_BRANCH_CODE) return null;
  return {
    bankName: EFT_BANK_NAME,
    accountName: EFT_ACCOUNT_NAME,
    accountNumber: EFT_ACCOUNT_NUMBER,
    branchCode: EFT_BRANCH_CODE,
  };
}

// --- What the app receives -----------------------------------------------------------------

export type Quote = PricedCart & { paymentMethods: typeof PAYMENT_METHOD_OPTIONS };

export type CustomerOrder = {
  orderNumber: string;
  status: string;
  statusLabel: string;
  statusMessage: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  paymentStatus: string;
  canCancel: boolean;
  placedAt: Date;
  updatedAt: Date;
  items: Array<{
    variantId: number;
    productId: number;
    name: string;
    size: string;
    quantity: number;
    unitPriceCents: number;
    unitPrice: string;
    lineTotalCents: number;
    lineTotal: string;
    imageUrl: string | null;
  }>;
  itemCount: number;
  subtotalCents: number;
  subtotal: string;
  deliveryFeeCents: number;
  deliveryFee: string;
  totalCents: number;
  total: string;
  deliveryAddress: {
    recipientName: string;
    streetAddress: string;
    city: string;
    postalCode: string;
    phone: string;
  };
  courierReference: string | null;
  cancelReason: string | null;
  /** Only while an EFT order waits for its payment. */
  paymentInstructions: {
    reference: string;
    amountCents: number;
    amount: string;
    bank: BankDetails | null;
  } | null;
  /** The four steps on the Orders tab: Order confirmed, Packed with care, On the way, Delivered. */
  tracking: TrackingStep[];
  history: Array<{ status: string; label: string; at: Date; note: string | null }>;
};

export type OrderSummary = {
  orderNumber: string;
  status: string;
  statusLabel: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  paymentStatus: string;
  canCancel: boolean;
  placedAt: Date;
  itemCount: number;
  totalCents: number;
  total: string;
  firstItem: { name: string; size: string; imageUrl: string | null } | null;
};

export function toCustomerOrder(
  row: OrderDetailRow,
  bank: BankDetails | null = bankDetails(),
): CustomerOrder {
  const total = formatPrice(row.totalCents);
  const waitingForEft =
    row.paymentMethod === 'EFT' &&
    row.status === 'Pending payment' &&
    row.paymentStatus === 'Unpaid';
  return {
    orderNumber: row.orderNumber,
    status: row.status,
    statusLabel: statusLabel(row.status),
    statusMessage: statusMessage({ ...row, total }),
    paymentMethod: row.paymentMethod,
    paymentMethodLabel: paymentMethodLabel(row.paymentMethod),
    paymentStatus: row.paymentStatus,
    canCancel: customerCanCancel(row.status, row.paymentStatus),
    placedAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => ({
      variantId: item.variantId,
      productId: item.productId,
      name: item.productName,
      size: item.size,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      unitPrice: formatPrice(item.unitPriceCents),
      lineTotalCents: item.lineTotalCents,
      lineTotal: formatPrice(item.lineTotalCents),
      imageUrl: item.imageUrl,
    })),
    itemCount: row.items.reduce((sum, item) => sum + item.quantity, 0),
    subtotalCents: row.subtotalCents,
    subtotal: formatPrice(row.subtotalCents),
    deliveryFeeCents: row.deliveryCents,
    deliveryFee: formatPrice(row.deliveryCents),
    totalCents: row.totalCents,
    total,
    deliveryAddress: {
      recipientName: row.recipientName,
      streetAddress: row.streetAddress,
      city: row.city,
      postalCode: row.postalCode,
      phone: row.phone,
    },
    courierReference: row.courierReference,
    cancelReason: row.cancelReason,
    paymentInstructions: waitingForEft
      ? { reference: row.orderNumber, amountCents: row.totalCents, amount: total, bank }
      : null,
    tracking: trackingSteps(row.history),
    history: row.history.map((entry) => ({
      status: entry.status,
      label: statusLabel(entry.status),
      at: entry.at,
      note: entry.note,
    })),
  };
}

function toSummary(row: OrderSummaryRow): OrderSummary {
  return {
    orderNumber: row.orderNumber,
    status: row.status,
    statusLabel: statusLabel(row.status),
    paymentMethod: row.paymentMethod,
    paymentMethodLabel: paymentMethodLabel(row.paymentMethod),
    paymentStatus: row.paymentStatus,
    canCancel: customerCanCancel(row.status, row.paymentStatus),
    placedAt: row.createdAt,
    itemCount: row.itemCount,
    totalCents: row.totalCents,
    total: formatPrice(row.totalCents),
    firstItem: row.firstItem,
  };
}

const addressLine = (order: CustomerOrder) =>
  [
    order.deliveryAddress.recipientName,
    order.deliveryAddress.streetAddress,
    order.deliveryAddress.city,
    order.deliveryAddress.postalCode,
  ].join(', ');

// --- Quote ------------------------------------------------------------------------------------

/** POST /cart/quote: prices the bag from the database. Problems are listed, never refused. */
export async function quoteCart(input: QuoteInput): Promise<Quote> {
  const variants = await repo.findVariantsForSale(
    pool,
    input.items.map((line) => line.variantId),
    { lock: false },
  );
  return { ...priceCart(input.items, variants), paymentMethods: PAYMENT_METHOD_OPTIONS };
}

// --- Placing an order -----------------------------------------------------------------------

export type OrderReply = StoredResponse & { replayed: boolean };

/** POST /orders */
export async function placeOrder(
  customerId: number,
  input: PlaceOrderInput,
  claim: IdempotencyClaim,
): Promise<OrderReply> {
  const outcome = await withTransaction(async (client) => {
    // 1. One order at a time per customer.
    const buyer = await repo.lockBuyer(client, customerId);
    if (!buyer) throw errors.unauthorized('Your session has ended. Please sign in again.');

    // 2. The same request again (a double tap): reply as the first time.
    const stored = await claimIdempotencyKey(client, claim);
    if (stored) return { reply: stored, replayed: true as const };

    if ((await repo.countOpenUnpaidOrders(client, customerId)) >= MAX_OPEN_ORDERS) {
      throw errors.conflict(
        `You already have ${MAX_OPEN_ORDERS} orders waiting for payment or delivery. ` +
          'Please wait for one to arrive, or cancel one, before placing another.',
      );
    }

    // 3. Lock the sizes, then check stock and price from the database.
    const variants = await repo.findVariantsForSale(
      client,
      input.items.map((line) => line.variantId),
      { lock: true },
    );
    const cart = priceCart(input.items, variants);
    if (!cart.canPlaceOrder) throw cartConflict(cart);

    // 4. Save the order, its lines and its first status, and take the stock.
    const status = FIRST_STATUS[input.paymentMethod];
    const { orderId } = await repo.insertOrder(client, {
      customerId,
      status,
      paymentMethod: input.paymentMethod,
      recipientName: input.recipientName,
      streetAddress: input.streetAddress,
      city: input.city,
      postalCode: input.postalCode,
      phone: input.phone,
      subtotalCents: cart.subtotalCents,
      deliveryCents: cart.deliveryFeeCents,
      totalCents: cart.totalCents,
    });
    await repo.insertOrderItems(
      client,
      orderId,
      cart.lines.map((line) => ({
        variantId: line.variantId,
        productName: line.name!,
        size: line.size!,
        unitPriceCents: line.unitPriceCents!,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents!,
      })),
    );
    await repo.addStatusHistory(client, orderId, status);
    await repo.changeStock(
      client,
      cart.lines.map((line) => ({ variantId: line.variantId, change: -line.quantity })),
    );

    // 5. Keep the reply, so a repeat of this request gets it back.
    const order = toCustomerOrder((await repo.findOrderDetail(client, { orderId }))!);
    const reply: StoredResponse = { status: 201, body: order };
    await saveIdempotentResponse(client, claim, reply);
    return { reply, replayed: false as const, order, buyer };
  });

  if (!outcome.replayed) {
    const { order, buyer } = outcome;
    sendEmailInBackground(
      orderPlaced({
        to: buyer.email,
        name: buyer.firstName,
        orderNumber: order.orderNumber,
        items: order.items,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        total: order.total,
        deliveryAddress: addressLine(order),
        paymentMethod: input.paymentMethod,
        bank: order.paymentInstructions?.bank ?? null,
      }),
      'order-placed',
    );
  }
  return { ...outcome.reply, replayed: outcome.replayed };
}

// --- The customer's orders -----------------------------------------------------------------

/** GET /me/orders */
export async function listMyOrders(
  customerId: number,
  filters: MyOrdersQuery,
): Promise<{ orders: OrderSummary[]; meta: PageMeta }> {
  const { rows, total } = await repo.listCustomerOrders(
    customerId,
    pageToLimitOffset(filters.page, filters.pageSize),
  );
  return { orders: rows.map(toSummary), meta: pageMeta(filters.page, filters.pageSize, total) };
}

/** GET /me/orders/:orderNumber. Another customer's order is "not found". */
export async function getMyOrder(customerId: number, orderNumber: string): Promise<CustomerOrder> {
  const row = await repo.findOrderDetail(pool, { customerId, orderNumber });
  if (!row) throw orderNotFound();
  return toCustomerOrder(row);
}

function cannotCancel(status: string, paymentStatus: string) {
  if (status === 'Cancelled') return errors.conflict('This order is already cancelled.');
  if (status === 'Packed') {
    return errors.conflict(
      "This order has already been packed, so it can't be cancelled here. " +
        'Please contact us if you need help.',
    );
  }
  if (status === 'Shipped') {
    return errors.conflict(
      "This order is already on the way, so it can't be cancelled. " +
        'Please contact us if you need help.',
    );
  }
  if (status === 'Delivered') {
    return errors.conflict("This order was already delivered, so it can't be cancelled.");
  }
  if (paymentStatus !== 'Unpaid') {
    return errors.conflict(
      'This order has been paid, so please contact us to cancel it and arrange your refund.',
    );
  }
  return errors.conflict("This order can't be cancelled.");
}

/** POST /me/orders/:orderNumber/cancel: the stock goes back. */
export async function cancelMyOrder(
  customerId: number,
  orderNumber: string,
  input: CancelOrderInput,
): Promise<CustomerOrder> {
  const { order, buyer } = await withTransaction(async (client) => {
    const locked = await repo.lockCustomerOrder(client, customerId, orderNumber);
    if (!locked) throw orderNotFound();
    if (!customerCanCancel(locked.status, locked.paymentStatus)) {
      throw cannotCancel(locked.status, locked.paymentStatus);
    }

    const quantities = await repo.orderQuantities(client, locked.orderId);
    await repo.lockVariants(
      client,
      quantities.map((line) => line.variantId),
    );
    await repo.changeStock(
      client,
      quantities.map((line) => ({ variantId: line.variantId, change: line.quantity })),
    );
    await repo.markCancelled(client, locked.orderId, input.reason ?? null);
    await repo.addStatusHistory(client, locked.orderId, 'Cancelled', {
      note: 'Cancelled by the customer',
    });

    const detail = await repo.findOrderDetail(client, { orderId: locked.orderId });
    return { order: toCustomerOrder(detail!), buyer: await repo.findBuyer(client, customerId) };
  });

  if (buyer) {
    sendEmailInBackground(
      orderCancelled({ to: buyer.email, name: buyer.firstName, orderNumber: order.orderNumber }),
      'order-cancelled',
    );
  }
  return order;
}
