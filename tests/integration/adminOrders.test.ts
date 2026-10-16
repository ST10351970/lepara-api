import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken as signAdminToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import {
  signAccessToken as signCustomerToken,
} from '../../src/modules/customerAuth/customerAuth.tokens';
import type { EmailMessage } from '../../src/services/email';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Emails land in this list instead of being sent.
const outbox = vi.hoisted(() => [] as Array<{ template: string; to: string; text: string }>);
vi.mock('../../src/services/email', () => ({
  sendEmailInBackground: (message: EmailMessage, template: string) => {
    outbox.push({ template, to: message.to, text: message.text });
  },
}));

const app = createApp();
const tag = randomUUID().slice(0, 6).toUpperCase();
let adminId = 0;
let customerId = 0;
let categoryId = 0;
let variantId = 0;
let adminAuth = '';
let customerAuth = '';

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', adminAuth),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', adminAuth).send(body),
};

/** Places an order as the customer and returns its ID and number. */
async function placeOrder(paymentMethod: string, quantity = 1) {
  const res = await request(app)
    .post('/api/v1/orders')
    .set('Authorization', customerAuth)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ variantId, quantity }],
      recipientName: 'Naledi Mokoena',
      streetAddress: '18 Mofolo Street',
      city: 'Soweto',
      postalCode: '1801',
      phone: '071 234 5678',
      paymentMethod,
      acceptTerms: true,
    });
  expect(res.status).toBe(201);
  const [row] = await testQuery<{ order_id: number }>(
    'SELECT order_id FROM customer_order WHERE order_number = $1',
    [res.body.data.orderNumber],
  );
  return { id: row!.order_id, number: res.body.data.orderNumber as string };
}

async function stock(): Promise<number> {
  const [row] = await testQuery<{ n: number }>(
    'SELECT quantity_on_hand AS n FROM product_variant WHERE variant_id = $1',
    [variantId],
  );
  return row!.n;
}

describe.skipIf(!hasTestDatabase)('admin order management', () => {
  beforeAll(async () => {
    const username = `orders.${tag.toLowerCase()}`;
    const [adminRow] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Orders Admin', 'staff') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = adminRow!.admin_id;
    adminAuth = `Bearer ${signAdminToken(adminId, 0)}`;

    const [category] = await testQuery<{ category_id: number }>(
      'INSERT INTO product_category (name) VALUES ($1) RETURNING category_id',
      [`Admin orders ${tag}`],
    );
    categoryId = category!.category_id;
    const [product] = await testQuery<{ product_id: number }>(
      `INSERT INTO product (category_id, name, price_cents, is_active)
       VALUES ($1, 'Community tee', 25000, true) RETURNING product_id`,
      [categoryId],
    );
    const [variant] = await testQuery<{ variant_id: number }>(
      `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand)
       VALUES ($1, 'M', $2, 20) RETURNING variant_id`,
      [product!.product_id, `AOT-${tag}-M`],
    );
    variantId = variant!.variant_id;

    const [customer] = await testQuery<{ customer_id: number }>(
      `INSERT INTO customer (first_name, last_name, email, mobile, password_hash,
         terms_accepted_at, email_verified_at)
       VALUES ('Naledi', 'Mokoena', $1, '+27712345678', 'not-used', now(), now())
       RETURNING customer_id`,
      [`naledi.${tag}@example.com`],
    );
    customerId = customer!.customer_id;
    customerAuth = `Bearer ${signCustomerToken(customerId, 0)}`;
  });

  afterAll(async () => {
    const orders = 'SELECT order_id FROM customer_order WHERE customer_id = $1';
    await testQuery('DELETE FROM idempotency_key WHERE customer_id = $1', [customerId]);
    await testQuery(`DELETE FROM payment WHERE order_id IN (${orders})`, [customerId]);
    await testQuery(`DELETE FROM order_status_history WHERE order_id IN (${orders})`, [customerId]);
    await testQuery(`DELETE FROM order_item WHERE order_id IN (${orders})`, [customerId]);
    await testQuery('DELETE FROM customer_order WHERE customer_id = $1', [customerId]);
    await testQuery('DELETE FROM customer WHERE customer_id = $1', [customerId]);
    const products = 'SELECT product_id FROM product WHERE category_id = $1';
    await testQuery(`DELETE FROM product_variant WHERE product_id IN (${products})`, [categoryId]);
    await testQuery('DELETE FROM product WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM product_category WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('only admins can see orders', async () => {
    const res = await request(app).get('/api/v1/admin/orders').set('Authorization', customerAuth);
    expect(res.status).toBe(401);
  });

  it('runs an EFT order from payment to delivery, and the customer sees each step', async () => {
    const order = await placeOrder('EFT');

    const listed = await admin.get(`/orders?status=Pending%20payment&search=${order.number}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { orderId: number }) => row.orderId)).toEqual([order.id]);

    // The wrong amount is refused; the right amount confirms the order.
    const wrong = await admin.patch(`/orders/${order.id}/payment`, { amount: '300' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields[0].field).toBe('amount');
    const paid = await admin.patch(`/orders/${order.id}/payment`, { amount: '310.00' });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'Confirmed', paymentStatus: 'Paid' });
    expect(paid.body.data.payments[0]).toMatchObject({
      provider: 'Manual EFT',
      reference: order.number,
      amountCents: 31000,
    });

    // Skipping a status gets 409; Shipped without a courier reference gets 400.
    const skip = await admin.patch(`/orders/${order.id}/status`, { status: 'Delivered' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.message).toMatch(/next step is Packed/);
    const packed = await admin.patch(`/orders/${order.id}/status`, { status: 'Packed' });
    expect(packed.status).toBe(200);
    const noCourier = await admin.patch(`/orders/${order.id}/status`, { status: 'Shipped' });
    expect(noCourier.status).toBe(400);
    expect(noCourier.body.error.fields[0].field).toBe('courierReference');
    const shipped = await admin.patch(`/orders/${order.id}/status`, {
      status: 'Shipped',
      courierReference: 'TCG123456789',
    });
    expect(shipped.status).toBe(200);
    expect(shipped.body.data.courierReference).toBe('TCG123456789');
    const delivered = await admin.patch(`/orders/${order.id}/status`, { status: 'Delivered' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.history.at(-1).changedBy.adminId).toBe(adminId);

    // The customer's Orders tab shows each step with its time.
    const mine = await request(app)
      .get(`/api/v1/me/orders/${order.number}`)
      .set('Authorization', customerAuth);
    expect(mine.status).toBe(200);
    expect(
      mine.body.data.tracking.map((step: { title: string; done: boolean; at: string | null }) => [
        step.title,
        step.done,
        typeof step.at,
      ]),
    ).toEqual([
      ['Order confirmed', true, 'string'],
      ['Packed with care', true, 'string'],
      ['On the way', true, 'string'],
      ['Delivered', true, 'string'],
    ]);

    const [audits] = await testQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE admin_id = $1 AND table_name = 'customer_order' AND record_id = $2`,
      [adminId, String(order.id)],
    );
    expect(audits!.n).toBe(4);
    expect(outbox.map((sent: { template: string }) => sent.template)).toEqual(
      expect.arrayContaining([
        'order-payment-received',
        'order-packed',
        'order-shipped',
        'order-delivered',
      ]),
    );
  });

  it('an admin cancellation needs a reason and puts the stock back', async () => {
    const order = await placeOrder('Cash on delivery', 3);
    const before = await stock();
    const noReason = await admin.patch(`/orders/${order.id}/status`, { status: 'Cancelled' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fields[0].field).toBe('reason');

    const res = await admin.patch(`/orders/${order.id}/status`, {
      status: 'Cancelled',
      reason: 'This size was damaged in storage.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'Cancelled',
      cancelReason: 'This size was damaged in storage.',
    });
    expect(await stock()).toBe(before + 3);
    expect(outbox.at(-1)).toMatchObject({ template: 'order-cancelled-by-us' });
  });
});
