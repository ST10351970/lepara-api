import { describe, expect, it } from 'vitest';
import { requestHashOf, stableJson } from '../../src/middleware/idempotency';
import { orderCancelled, orderPlaced } from '../../src/services/emailTemplates';
import {
  customerCanCancel,
  statusMessage,
  trackingSteps,
} from '../../src/modules/orders/orders.format';
import {
  type VariantForSale,
  cartConflict,
  priceCart,
} from '../../src/modules/orders/orders.pricing';
import {
  orderNumberParams,
  placeOrderSchema,
  quoteSchema,
} from '../../src/modules/orders/orders.schemas';
import { bankDetails, toCustomerOrder } from '../../src/modules/orders/orders.service';
import type { OrderDetailRow } from '../../src/modules/orders/orders.repository';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

const variant = (overrides: Partial<VariantForSale>): VariantForSale => ({
  variantId: 1,
  productId: 10,
  size: 'M',
  quantityOnHand: 5,
  productName: 'Community hoodie',
  priceCents: 45000,
  isActive: true,
  imageUrl: null,
  ...overrides,
});

const shop = new Map<number, VariantForSale>([
  [1, variant({})],
  [
    2,
    variant({
      variantId: 2,
      productId: 11,
      size: 'One size',
      productName: 'Community cap',
      priceCents: 15050,
      quantityOnHand: 2,
    }),
  ],
  [3, variant({ variantId: 3, size: 'L', quantityOnHand: 0 })],
  [4, variant({ variantId: 4, productId: 12, productName: 'Old tee', isActive: false })],
]);

describe('pricing the bag', () => {
  it('works in whole cents from database prices, with delivery added once', () => {
    const cart = priceCart(
      [
        { variantId: 1, quantity: 2 },
        { variantId: 2, quantity: 1 },
      ],
      shop,
      6000,
    );
    expect(cart.subtotalCents).toBe(105050);
    expect(cart.deliveryFeeCents).toBe(6000);
    expect(cart.totalCents).toBe(111050);
    expect(cart.total).toBe('R1 110.50');
    expect(cart.itemCount).toBe(3);
    expect(cart.lines[0]).toMatchObject({
      lineTotalCents: 90000,
      lineTotal: 'R900',
      problem: null,
    });
    expect(cart.canPlaceOrder).toBe(true);
  });

  it('names the item and how many are left', () => {
    const cart = priceCart(
      [
        { variantId: 1, quantity: 6 },
        { variantId: 3, quantity: 1 },
        { variantId: 2, quantity: 3 },
      ],
      shop,
      6000,
    );
    expect(cart.lines.map((line) => line.problem)).toEqual([
      'Community hoodie (size M): only 5 left. Please lower the quantity.',
      'Community hoodie (size L) is sold out. Please remove it or choose another size.',
      'Community cap (one size): only 2 left. Please lower the quantity.',
    ]);
    expect(cart.canPlaceOrder).toBe(false);
  });

  it('shows hidden or removed items as unavailable, without a price', () => {
    const cart = priceCart(
      [
        { variantId: 4, quantity: 1 },
        { variantId: 99, quantity: 1 },
      ],
      shop,
      6000,
    );
    expect(cart.lines.map((line) => [line.availability, line.unitPriceCents])).toEqual([
      ['Unavailable', null],
      ['Unavailable', null],
    ]);
    expect(cart.lines[0]!.problem).toBe(
      'Old tee is no longer available. Please remove it from your bag.',
    );
    expect(cart.lines[1]!.problem).toBe(
      'This item is no longer available. Please remove it from your bag.',
    );
    expect(cart.totalCents).toBe(0); // nothing to deliver, so no delivery fee
  });

  it('refuses an order with 409, each problem under its line', () => {
    const one = cartConflict(priceCart([{ variantId: 3, quantity: 1 }], shop, 6000));
    expect(one.status).toBe(409);
    expect(one.message).toMatch(/sold out/);
    expect(one.fields).toEqual([{ field: 'items.0', message: one.message }]);
    const several = cartConflict(
      priceCart(
        [
          { variantId: 3, quantity: 1 },
          { variantId: 4, quantity: 1 },
        ],
        shop,
        6000,
      ),
    );
    expect(several.message).toBe(
      'Some items in your bag have changed. Please check them and try again.',
    );
    expect(several.fields?.map((field) => field.field)).toEqual(['items.0', 'items.1']);
  });
});

describe('checkout form', () => {
  const valid = {
    items: [{ variantId: 1, quantity: 2 }],
    recipientName: 'Naledi Mokoena',
    streetAddress: '18 Mofolo Street',
    city: 'Soweto',
    postalCode: '1801',
    phone: '071 234 5678',
    paymentMethod: 'EFT',
    acceptTerms: true,
  };

  it('ignores any price or total the app sends', () => {
    const parsed = placeOrderSchema.parse({
      ...valid,
      items: [{ variantId: '1', quantity: 2, unitPrice: 1, lineTotal: 2 }],
      total: 3,
      subtotalCents: 3,
    });
    expect(parsed.items).toEqual([{ variantId: 1, quantity: 2 }]);
    expect('total' in parsed).toBe(false);
    expect(parsed.phone).toBe('+27712345678');
  });

  it('explains each problem under its field', () => {
    expect(
      firstMessages(
        placeOrderSchema.safeParse({
          ...valid,
          items: [
            { variantId: 1, quantity: 11 },
            { variantId: 1, quantity: 1 },
          ],
          postalCode: '180',
          paymentMethod: 'Debit / credit card',
          acceptTerms: false,
        }),
      ),
    ).toEqual({
      'items.0.quantity': 'Please choose a quantity from 1 to 10.',
      'items.1.variantId': 'This size is already in your bag. Change its quantity instead.',
      postalCode: 'Postal codes have 4 digits.',
      paymentMethod: 'Please choose EFT bank transfer or cash on delivery.',
      acceptTerms: 'Please tick the box to agree to the terms before placing your order.',
    });
  });

  it('needs 1 to 20 lines', () => {
    expect(firstMessages(quoteSchema.safeParse({ items: [] }))).toEqual({
      items: 'Your bag is empty.',
    });
    const many = Array.from({ length: 21 }, (_, index) => ({ variantId: index + 1, quantity: 1 }));
    expect(firstMessages(quoteSchema.safeParse({ items: many }))).toEqual({
      items: 'You can order up to 20 different items at once.',
    });
  });

  it('reads order numbers in any capitals', () => {
    expect(orderNumberParams.parse({ orderNumber: ' lafm-1008 ' })).toEqual({
      orderNumber: 'LAFM-1008',
    });
    expect(orderNumberParams.safeParse({ orderNumber: '1008' }).success).toBe(false);
  });
});

describe('order tracking', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 10, minute));

  it('marks each step done with its time', () => {
    const steps = trackingSteps([
      { status: 'Pending payment', at: at(0), note: null },
      { status: 'Confirmed', at: at(5), note: null },
      { status: 'Packed', at: at(9), note: null },
    ]);
    expect(steps.map((step) => [step.title, step.done, step.at])).toEqual([
      ['Order confirmed', true, at(5)],
      ['Packed with care', true, at(9)],
      ['On the way', false, null],
      ['Delivered', false, null],
    ]);
  });

  it('lets customers cancel only unpaid orders that are not packed yet', () => {
    expect(customerCanCancel('Pending payment', 'Unpaid')).toBe(true);
    expect(customerCanCancel('Confirmed', 'Unpaid')).toBe(true);
    expect(customerCanCancel('Confirmed', 'Paid')).toBe(false);
    expect(customerCanCancel('Packed', 'Unpaid')).toBe(false);
    expect(customerCanCancel('Cancelled', 'Unpaid')).toBe(false);
  });

  it('says what happens next', () => {
    const base = {
      orderNumber: 'LAFM-1008',
      total: 'R310',
      courierReference: null,
      paymentStatus: 'Unpaid',
    };
    expect(statusMessage({ ...base, status: 'Pending payment', paymentMethod: 'EFT' })).toBe(
      'Please pay R310 by EFT with LAFM-1008 as the reference. ' +
        "We'll confirm your order when the payment arrives.",
    );
    expect(
      statusMessage({ ...base, status: 'Confirmed', paymentMethod: 'Cash on delivery' }),
    ).toMatch(/pay R310 in cash/);
    const shipped = {
      ...base,
      status: 'Shipped',
      paymentMethod: 'EFT',
      courierReference: 'TCG123',
    };
    expect(statusMessage(shipped)).toBe('Your order is on the way. Courier reference: TCG123.');
  });
});

describe('order replies', () => {
  const row: OrderDetailRow = {
    orderId: 1,
    orderNumber: 'LAFM-1008',
    customerId: 7,
    status: 'Pending payment',
    paymentMethod: 'EFT',
    paymentStatus: 'Unpaid',
    recipientName: 'Naledi Mokoena',
    streetAddress: '18 Mofolo Street',
    city: 'Soweto',
    postalCode: '1801',
    phone: '+27712345678',
    subtotalCents: 25000,
    deliveryCents: 6000,
    totalCents: 31000,
    courierReference: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        variantId: 1,
        productId: 10,
        productName: 'Community tee',
        size: 'M',
        unitPriceCents: 25000,
        quantity: 1,
        lineTotalCents: 25000,
        imageUrl: null,
      },
    ],
    history: [{ status: 'Pending payment', note: null, at: new Date() }],
  };
  const bank = {
    bankName: 'Example Bank',
    accountName: 'Lepara Ale fele Moya NPC',
    accountNumber: '1234567890',
    branchCode: '250655',
  };

  it('gives EFT payment instructions only while the payment is awaited', () => {
    expect(toCustomerOrder(row, bank).paymentInstructions).toEqual({
      reference: 'LAFM-1008',
      amountCents: 31000,
      amount: 'R310',
      bank,
    });
    const paid = { ...row, status: 'Confirmed', paymentStatus: 'Paid' };
    expect(toCustomerOrder(paid, bank).paymentInstructions).toBeNull();
    expect(
      toCustomerOrder({ ...row, paymentMethod: 'Cash on delivery', status: 'Confirmed' }, bank)
        .paymentInstructions,
    ).toBeNull();
  });

  it('uses the bank details only when all four are set', () => {
    const all = {
      EFT_BANK_NAME: 'Example Bank',
      EFT_ACCOUNT_NAME: 'Lepara',
      EFT_ACCOUNT_NUMBER: '123456',
      EFT_BRANCH_CODE: '250655',
    };
    expect(bankDetails(all)).toMatchObject({ bankName: 'Example Bank', branchCode: '250655' });
    expect(bankDetails({ ...all, EFT_BRANCH_CODE: undefined })).toBeNull();
  });
});

describe('order emails', () => {
  const email = {
    to: 'naledi@example.com',
    name: 'Naledi',
    orderNumber: 'LAFM-1008',
    items: [{ name: 'Tee <b>bold</b>', size: 'M', quantity: 2, lineTotal: 'R500' }],
    subtotal: 'R500',
    deliveryFee: 'R60',
    total: 'R560',
    deliveryAddress: '18 Mofolo Street, Soweto, 1801',
    paymentMethod: 'EFT' as const,
    bank: {
      bankName: 'Example Bank',
      accountName: 'Lepara',
      accountNumber: '1234567890',
      branchCode: '250655',
    },
  };

  it('EFT: the order number is the reference, with the bank details and amount', () => {
    const message = orderPlaced(email);
    expect(message.subject).toBe('Order received: LAFM-1008');
    expect(message.text).toMatch(/Please pay R560 by EFT, with LAFM-1008 as the payment reference/);
    expect(message.text).toMatch(/Account number: 1234567890/);
    expect(message.text).toMatch(/2 × Tee <b>bold<\/b> \(size M\): R500/);
    expect(message.html).toContain('Tee &lt;b&gt;bold&lt;/b&gt;');
    expect(message.html).not.toContain('<b>bold</b>');
    expect(orderPlaced({ ...email, bank: null }).text).toMatch(/Reply to this email/);
  });

  it('cash on delivery and cancelled orders', () => {
    const cod = orderPlaced({ ...email, paymentMethod: 'Cash on delivery' });
    expect(cod.subject).toBe('Order confirmed: LAFM-1008');
    expect(cod.text).toMatch(/Please have R560 in cash ready/);
    expect(cod.text).not.toMatch(/Account number/);
    expect(orderCancelled({ to: 'a@b.co', name: 'Naledi', orderNumber: 'LAFM-1008' }).subject).toBe(
      'Order cancelled: LAFM-1008',
    );
  });
});

describe('Idempotency-Key fingerprints', () => {
  it('are the same for the same request, whatever the key order', () => {
    expect(stableJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
    expect(requestHashOf({ a: 1, b: 2 })).toBe(requestHashOf({ b: 2, a: 1 }));
    expect(requestHashOf({ items: [{ variantId: 1, quantity: 1 }] })).not.toBe(
      requestHashOf({ items: [{ variantId: 1, quantity: 2 }] }),
    );
    expect(requestHashOf({ a: 1, b: undefined })).toBe(requestHashOf({ a: 1 }));
  });
});
