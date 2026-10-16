import type { OrderStatus } from './orders.format';

/**
 * How an order's status may change, as data. Nothing moves backwards and
 * nothing skips a step:
 *
 *   Pending payment ──(EFT payment recorded)──▶ Confirmed
 *   Confirmed ──▶ Packed ──▶ Shipped (needs a courier reference) ──▶ Delivered
 *   Pending payment, Confirmed or Packed ──▶ Cancelled (needs a reason; stock goes back)
 *
 * Delivered and Cancelled are final.
 */

/** The one step an admin may move an order forward to. */
const NEXT: Partial<Record<string, OrderStatus>> = {
  Confirmed: 'Packed',
  Packed: 'Shipped',
  Shipped: 'Delivered',
};

/** Once shipped, the goods have left: it can't be cancelled. */
const ADMIN_CANCELLABLE = new Set(['Pending payment', 'Confirmed', 'Packed']);

const FINAL = new Set(['Delivered', 'Cancelled']);

const RANK: Record<string, number> = {
  'Pending payment': 0,
  Confirmed: 1,
  Packed: 2,
  Shipped: 3,
  Delivered: 4,
};

export function nextStatus(status: string): OrderStatus | null {
  return NEXT[status] ?? null;
}

export function adminCanCancel(status: string): boolean {
  return ADMIN_CANCELLABLE.has(status);
}

/**
 * Why an admin can't move the order from `from` to `to`, for the 409 reply,
 * or null when the move is allowed.
 */
export function statusRefusal(from: string, to: string): string | null {
  if (from === to) return `This order is already ${from}.`;
  if (FINAL.has(from)) {
    return `This order is already ${from}, which is final, so it can't be changed.`;
  }
  if (to === 'Cancelled') {
    return adminCanCancel(from)
      ? null
      : "This order is already on its way, so it can't be cancelled.";
  }
  if (from === 'Pending payment') {
    return to === 'Confirmed'
      ? 'This order is waiting for its EFT payment. Record the payment to confirm it.'
      : 'This order is waiting for its EFT payment. Record the payment before packing it.';
  }
  if (NEXT[from] === to) return null;
  if ((RANK[to] ?? 0) < (RANK[from] ?? 0)) {
    return `Orders only move forward: this order is already ${from}.`;
  }
  return `Orders move one step at a time: this order is ${from}, so the next step is ${NEXT[from]}.`;
}
