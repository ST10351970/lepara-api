import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken as signAdminToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { signAccessToken } from '../../src/modules/customerAuth/customerAuth.tokens';
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
let categoryId = 0;
const customers: number[] = [];
const variants: Record<string, number> = {};
const auth: Record<'alice' | 'bob', string> = { alice: '', bob: '' };

const DELIVERY = {
  recipientName: 'Naledi Mokoena',
  streetAddress: '18 Mofolo Street',
  city: 'Soweto',
  postalCode: '1801',
  phone: '071 234 5678',
  acceptTerms: true,
};

const api = (path: string) => `/api/v1${path}`;
const quote = (items: object[]) => request(app).post(api('/cart/quote')).send({ items });

function placeOrder(
  who: 'alice' | 'bob',
  items: object[],
  { paymentMethod = 'EFT', key = randomUUID() }: { paymentMethod?: string; key?: string } = {},
) {
  return request(app)
    .post(api('/orders'))
    .set('Authorization', auth[who])
    .set('Idempotency-Key', key)
    .send({ items, paymentMethod, ...DELIVERY });
}

const myOrders = (who: 'alice' | 'bob', path = '') =>
  request(app).get(api(`/me/orders${path}`)).set('Authorization', auth[who]);

async function stockOf(name: string): Promise<number> {
  const [row] = await testQuery<{ n: number }>(
    'SELECT quantity_on_hand AS n FROM product_variant WHERE variant_id = $1',
    [variants[name]],
  );
  return row!.n;
}

describe.skipIf(!hasTestDatabase)('cart and orders', () => {
  beforeAll(async () => {
    const [category] = await testQuery<{ category_id: number }>(
      'INSERT INTO product_category (name) VALUES ($1) RETURNING category_id',
      [`Orders test ${tag}`],
    );
    categoryId = category!.category_id;

    const product = async (name: string, priceCents: number, sizes: Array<[string, number]>) => {
      const [row] = await testQuery<{ product_id: number }>(
        `INSERT INTO product (category_id, name, price_cents, is_active)
         VALUES ($1, $2, $3, true) RETURNING product_id`,
        [categoryId, name, priceCents],
      );
      for (const [size, quantity] of sizes) {
        const [variant] = await testQuery<{ variant_id: number }>(
          `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand)
           VALUES ($1, $2, $3, $4) RETURNING variant_id`,
          [row!.product_id, size, `${name.slice(10, 13).toUpperCase()}-${tag}-${size}`, quantity],
        );
        variants[`${name} ${size}`] = variant!.variant_id;
      }
    };
    await product('Community hoodie', 45000, [
      ['M', 1],
      ['L', 5],
    ]);
    await product('Community tee', 25000, [['S', 10]]);

    for (const who of ['alice', 'bob'] as const) {
      const [row] = await testQuery<{ customer_id: number }>(
        `INSERT INTO customer (first_name, last_name, email, mobile, password_hash,
           terms_accepted_at, email_verified_at)
         VALUES ($1, 'Test', $2, '+27712345678', 'not-used', now(), now())
         RETURNING customer_id`,
        [who, `${who}.${tag}@example.com`],
      );
      customers.push(row!.customer_id);
      auth[who] = `Bearer ${signAccessToken(row!.customer_id, 0)}`;
    }
  });

  afterAll(async () => {
    const orders = 'SELECT order_id FROM customer_order WHERE customer_id = ANY($1)';
    await testQuery('DELETE FROM idempotency_key WHERE customer_id = ANY($1)', [customers]);
    await testQuery(`DELETE FROM order_status_history WHERE order_id IN (${orders})`, [customers]);
    await testQuery(`DELETE FROM order_item WHERE order_id IN (${orders})`, [customers]);
    await testQuery('DELETE FROM customer_order WHERE customer_id = ANY($1)', [customers]);
    await testQuery('DELETE FROM customer WHERE customer_id = ANY($1)', [customers]);
    const products = 'SELECT product_id FROM product WHERE category_id = $1';
    await testQuery(`DELETE FROM product_variant WHERE product_id IN (${products})`, [categoryId]);
    await testQuery('DELETE FROM product WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM product_category WHERE category_id = $1', [categoryId]);
    await closeTestClient();
    await closePool();
  });

  it('prices the bag from the database: a price in the request has no effect', async () => {
    const res = await quote([
      { variantId: variants['Community hoodie L'], quantity: 2, unitPrice: 1, lineTotal: 2 },
      { variantId: variants['Community tee S'], quantity: 1, priceCents: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      subtotalCents: 115000,
      deliveryFeeCents: 6000,
      totalCents: 121000,
      total: 'R1 210',
      canPlaceOrder: true,
    });
    expect(res.body.data.paymentMethods.map((option: { value: string }) => option.value)).toEqual([
      'EFT',
      'Cash on delivery',
    ]);
  });

  it('needs a signed-in customer and an Idempotency-Key header', async () => {
    const items = [{ variantId: variants['Community tee S'], quantity: 1 }];
    const anonymous = await request(app)
      .post(api('/orders'))
      .set('Idempotency-Key', randomUUID())
      .send({ items, paymentMethod: 'EFT', ...DELIVERY });
    expect(anonymous.status).toBe(401);

    const noKey = await request(app)
      .post(api('/orders'))
      .set('Authorization', auth.alice)
      .send({ items, paymentMethod: 'EFT', ...DELIVERY });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.message).toMatch(/Idempotency-Key/);

    const adminToken = await request(app)
      .get(api('/me/orders'))
      .set('Authorization', `Bearer ${signAdminToken(1, 0)}`);
    expect(adminToken.status).toBe(401);
  });

  let eftOrder = '';

  it('places an EFT order: the quote total is the order total, and stock is taken', async () => {
    const items = [{ variantId: variants['Community hoodie L'], quantity: 2 }];
    const priced = await quote(items);
    const res = await placeOrder('alice', items);
    expect(res.status).toBe(201);
    const order = res.body.data;
    eftOrder = order.orderNumber;
    expect(order.orderNumber).toMatch(/^LAFM-\d+$/);
    expect(order.status).toBe('Pending payment');
    expect(order.totalCents).toBe(priced.body.data.totalCents);
    expect(order.paymentInstructions).toMatchObject({
      reference: order.orderNumber,
      amountCents: order.totalCents,
    });
    expect(await stockOf('Community hoodie L')).toBe(3);
    expect(outbox.at(-1)).toMatchObject({
      template: 'order-placed',
      to: `alice.${tag}@example.com`,
    });
  });

  it('cash on delivery starts as Confirmed', async () => {
    const res = await placeOrder('bob', [{ variantId: variants['Community tee S'], quantity: 1 }], {
      paymentMethod: 'Cash on delivery',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('Confirmed');
    expect(res.body.data.paymentInstructions).toBeNull();
    expect(res.body.data.tracking[0]).toMatchObject({ title: 'Order confirmed', done: true });
  });

  it('repeating a request with the same Idempotency-Key creates no second order', async () => {
    const key = randomUUID();
    const items = [{ variantId: variants['Community tee S'], quantity: 2 }];
    const first = await placeOrder('alice', items, { key });
    const again = await placeOrder('alice', items, { key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.orderNumber).toBe(first.body.data.orderNumber);
    const [row] = await testQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM customer_order WHERE order_number = $1',
      [first.body.data.orderNumber],
    );
    expect(row!.n).toBe(1);

    const different = await placeOrder(
      'alice',
      [{ variantId: variants['Community tee S'], quantity: 3 }],
      { key },
    );
    expect(different.status).toBe(422);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('two orders at once for the last size M hoodie: one succeeds, the other 409', async () => {
    const items = [{ variantId: variants['Community hoodie M'], quantity: 1 }];
    const results = await Promise.all([placeOrder('alice', items), placeOrder('bob', items)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    const refused = results.find((res) => res.status === 409)!;
    expect(refused.body.error.message).toBe(
      'Community hoodie (size M) is sold out. Please remove it or choose another size.',
    );
    expect(await stockOf('Community hoodie M')).toBe(0);
  });

  it("customer B gets 404 for customer A's order, and sees only their own orders", async () => {
    const theirs = await myOrders('bob', `/${eftOrder}`);
    expect(theirs.status).toBe(404);
    const cancelTheirs = await request(app)
      .post(api(`/me/orders/${eftOrder}/cancel`))
      .set('Authorization', auth.bob);
    expect(cancelTheirs.status).toBe(404);

    const mine = await myOrders('alice', `/${eftOrder.toLowerCase()}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.orderNumber).toBe(eftOrder);
    expect(mine.body.data.history.map((entry: { status: string }) => entry.status)).toEqual([
      'Pending payment',
    ]);

    const list = await myOrders('bob');
    expect(list.status).toBe(200);
    expect(list.body.data.map((order: { orderNumber: string }) => order.orderNumber)).not.toContain(
      eftOrder,
    );
  });

  it('cancelling restores the stock; cancelling again gets 409', async () => {
    const before = await stockOf('Community hoodie L');
    const res = await request(app)
      .post(api(`/me/orders/${eftOrder}/cancel`))
      .set('Authorization', auth.alice)
      .send({ reason: 'Wrong size' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Cancelled');
    expect(res.body.data.history.map((entry: { status: string }) => entry.status)).toEqual([
      'Pending payment',
      'Cancelled',
    ]);
    expect(await stockOf('Community hoodie L')).toBe(before + 2);

    const again = await request(app)
      .post(api(`/me/orders/${eftOrder}/cancel`))
      .set('Authorization', auth.alice);
    expect(again.status).toBe(409);
  });
});
