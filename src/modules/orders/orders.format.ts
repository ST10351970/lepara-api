/**
 * The words the app shows for orders, kept in one place so the Orders tab,
 * the checkout and the emails always agree.
 */

export const ORDER_STATUSES = [
  'Pending payment',
  'Confirmed',
  'Packed',
  'Shipped',
  'Delivered',
  'Cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** PayFast is in the database for later; customers can choose these two. */
export const PAYMENT_METHODS = ['EFT', 'Cash on delivery'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentStatus = 'Unpaid' | 'Paid' | 'Refunded';

/** EFT waits for the money; cash on delivery can be packed straight away. */
export const FIRST_STATUS: Record<PaymentMethod, OrderStatus> = {
  EFT: 'Pending payment',
  'Cash on delivery': 'Confirmed',
};

export const PAYMENT_METHOD_OPTIONS: Array<{
  value: PaymentMethod;
  label: string;
  note: string;
}> = [
  {
    value: 'EFT',
    label: 'EFT bank transfer',
    note: 'Pay by bank transfer with your order number as the reference. We send your order once the payment arrives.',
  },
  {
    value: 'Cash on delivery',
    label: 'Cash on delivery',
    note: 'Pay the delivery driver in cash when your order arrives.',
  },
];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.label ?? method;
}

/** The app's wording for each status. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  'Pending payment': 'Waiting for payment',
  Confirmed: 'Order confirmed',
  Packed: 'Packed with care',
  Shipped: 'On the way',
  Delivered: 'Delivered',
  Cancelled: 'Cancelled',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as OrderStatus] ?? status;
}

/** The four steps on the tracking card, in order. */
export const TRACKING_STEPS: Array<{ title: string; status: OrderStatus }> = [
  { title: 'Order confirmed', status: 'Confirmed' },
  { title: 'Packed with care', status: 'Packed' },
  { title: 'On the way', status: 'Shipped' },
  { title: 'Delivered', status: 'Delivered' },
];

export type HistoryEntry = { status: string; at: Date; note: string | null };
export type TrackingStep = { title: string; status: OrderStatus; done: boolean; at: Date | null };

/**
 * Each step is done once the order has reached it, with the time it did.
 * A cancelled order keeps the steps it reached before it was cancelled.
 */
export function trackingSteps(history: HistoryEntry[]): TrackingStep[] {
  return TRACKING_STEPS.map((step) => {
    const reached = history.filter((entry) => entry.status === step.status).at(-1);
    return { ...step, done: reached !== undefined, at: reached?.at ?? null };
  });
}

/** Customers may cancel until the order is packed, as long as it hasn't been paid. */
export function customerCanCancel(status: string, paymentStatus: string): boolean {
  return (status === 'Pending payment' || status === 'Confirmed') && paymentStatus === 'Unpaid';
}

/** One sentence under the status, saying what happens next. */
export function statusMessage(order: {
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  orderNumber: string;
  total: string;
  courierReference: string | null;
}): string {
  switch (order.status) {
    case 'Pending payment':
      return (
        `Please pay ${order.total} by EFT with ${order.orderNumber} as the reference. ` +
        "We'll confirm your order when the payment arrives."
      );
    case 'Confirmed':
      return order.paymentMethod === 'Cash on delivery' && order.paymentStatus === 'Unpaid'
        ? `We're getting your order ready. Please pay ${order.total} in cash when it arrives.`
        : "Thank you, your payment was received. We're getting your order ready.";
    case 'Packed':
      return 'Your order is packed and will be on its way soon.';
    case 'Shipped':
      return order.courierReference
        ? `Your order is on the way. Courier reference: ${order.courierReference}.`
        : 'Your order is on the way.';
    case 'Delivered':
      return 'Your order was delivered. Thank you for supporting us!';
    default:
      return 'This order was cancelled.';
  }
}

/** "size M", or "one size" for accessories. */
export function sizeLabel(size: string): string {
  return size === 'One size' ? 'one size' : `size ${size}`;
}

/** LAFM-1008, typed in any case. */
export const ORDER_NUMBER_PATTERN = /^LAFM-\d{1,10}$/;
