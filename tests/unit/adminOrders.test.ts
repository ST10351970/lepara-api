import { describe, expect, it } from 'vitest';
import { orderCancelledByUs, orderShipped } from '../../src/services/emailTemplates';
import {
  orderPaymentSchema,
  orderStatusSchema,
} from '../../src/modules/orders/adminOrders.schemas';
import {
  adminCanCancel,
  nextStatus,
  statusRefusal,
} from '../../src/modules/orders/orders.transitions';

const fieldsOf = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]);

describe('order status rules', () => {
  it('moves forward one step at a time', () => {
    expect(statusRefusal('Confirmed', 'Packed')).toBeNull();
    expect(statusRefusal('Packed', 'Shipped')).toBeNull();
    expect(statusRefusal('Shipped', 'Delivered')).toBeNull();
    expect(nextStatus('Confirmed')).toBe('Packed');
    expect(nextStatus('Delivered')).toBeNull();
  });

  it('refuses skipping a step, going back, or repeating one', () => {
    expect(statusRefusal('Confirmed', 'Delivered')).toBe(
      'Orders move one step at a time: this order is Confirmed, so the next step is Packed.',
    );
    expect(statusRefusal('Shipped', 'Packed')).toBe(
      'Orders only move forward: this order is already Shipped.',
    );
    expect(statusRefusal('Packed', 'Packed')).toBe('This order is already Packed.');
    expect(statusRefusal('Delivered', 'Cancelled')).toMatch(/final/);
  });

  it('confirms an EFT order only through its payment', () => {
    expect(statusRefusal('Pending payment', 'Confirmed')).toMatch(
      /Record the payment to confirm it/,
    );
    expect(statusRefusal('Pending payment', 'Packed')).toMatch(/Record the payment before packing/);
  });

  it('cancels until the order is shipped', () => {
    expect(['Pending payment', 'Confirmed', 'Packed'].every(adminCanCancel)).toBe(true);
    expect(adminCanCancel('Shipped')).toBe(false);
    expect(statusRefusal('Shipped', 'Cancelled')).toBe(
      "This order is already on its way, so it can't be cancelled.",
    );
  });
});

describe('status changes from the dashboard', () => {
  it('needs a courier reference for Shipped', () => {
    expect(fieldsOf(orderStatusSchema.safeParse({ status: 'Shipped' }))).toEqual([
      [
        'courierReference',
        "Please enter the courier's tracking reference, for example TCG123456789.",
      ],
    ]);
    expect(
      orderStatusSchema.parse({ status: 'Shipped', courierReference: ' TCG 123456 ' })
        .courierReference,
    ).toBe('TCG 123456');
  });

  it('needs a reason for cancelling', () => {
    expect(fieldsOf(orderStatusSchema.safeParse({ status: 'Cancelled', reason: ' ' }))).toEqual([
      ['reason', 'Please give a reason for cancelling (at least 3 characters).'],
    ]);
  });

  it('reads the amount received in rands', () => {
    expect(orderPaymentSchema.parse({ amount: 'R310.00' }).amount).toBe(31000);
    const blank = orderPaymentSchema.parse({ amount: 310, reference: '' });
    expect(blank.amount).toBe(31000);
    expect(blank.reference).toBeUndefined();
    expect(orderPaymentSchema.safeParse({ amount: '310.005' }).success).toBe(false);
  });
});

describe('order update emails', () => {
  const to = { to: 'naledi@example.com', name: 'Naledi', orderNumber: 'LAFM-1008' };

  it('give the courier reference, and the cash due for cash on delivery', () => {
    const cash = orderShipped({ ...to, courierReference: 'TCG123', cashDue: 'R560' });
    expect(cash.subject).toBe('Your order is on the way: LAFM-1008');
    expect(cash.text).toMatch(/Courier reference: TCG123/);
    expect(cash.text).toMatch(/Please have R560 in cash ready/);
    const paid = orderShipped({ ...to, courierReference: 'TCG123', cashDue: null });
    expect(paid.text).not.toMatch(/in cash/);
  });

  it('give the admin reason for a cancellation, escaped', () => {
    const message = orderCancelledByUs({ ...to, reason: 'Damaged <stock>', refunded: 'R310' });
    expect(message.text).toMatch(/Reason: Damaged <stock>/);
    expect(message.html).toContain('Damaged &lt;stock&gt;');
    expect(message.text).toMatch(/Your payment of R310 has been paid back to you/);
  });
});
