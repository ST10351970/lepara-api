import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken as signAdminToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import {
  signAccessToken as signCustomerToken,
} from '../../src/modules/customerAuth/customerAuth.tokens';
import { waitForPendingNotifications } from '../../src/services/notifications';
import { type PushMessage, type PushSender, setPushSenderForTests } from '../../src/services/push';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

const app = createApp();
const tag = randomUUID().replace(/-/g, '').slice(0, 10);
let adminId = 0;
let customerId = 0;
let adminAuth = '';
let customerAuth = '';
let categoryId = 0;

/** A made-up FCM token; ones containing "dead" belong to uninstalled apps. */
const token = (name: string) => `test-${tag}:APA91b-${name}-xxxxxxxxxxxxxxxx`;

/** A pretend Firebase that remembers what it was asked to send. */
const sent: Array<{ tokens: string[]; message: PushMessage }> = [];
let unreachable = false;
const fakeFirebase: PushSender = async (tokens, message) => {
  if (unreachable) throw new Error('Firebase is unreachable');
  sent.push({ tokens, message });
  return tokens.map((value) => ({
    token: value,
    ok: !value.includes('dead'),
    invalidToken: value.includes('dead'),
  }));
};

const register = (name: string, auth?: string) => {
  const req = request(app).post('/api/v1/devices');
  if (auth) req.set('Authorization', auth);
  return req.send({ token: token(name), platform: 'android' });
};

async function deviceRow(name: string) {
  const [row] = await testQuery<{ customer_id: number | null }>(
    'SELECT customer_id FROM device_token WHERE token = $1',
    [token(name)],
  );
  return row;
}

/** Only this file's test phones (the test database may hold others). */
const ours = (tokens: string[]) => tokens.filter((value) => value.startsWith(`test-${tag}:`));

describe.skipIf(!hasTestDatabase)('devices and push notifications', () => {
  beforeAll(async () => {
    const username = `push.${tag}`;
    const [admin] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Push Admin', 'staff') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = admin!.admin_id;
    adminAuth = `Bearer ${signAdminToken(adminId, 0)}`;
    const [customer] = await testQuery<{ customer_id: number }>(
      `INSERT INTO customer (first_name, last_name, email, mobile, password_hash,
         terms_accepted_at, email_verified_at)
       VALUES ('Naledi', 'Mokoena', $1, '+27712345678', 'not-used', now(), now())
       RETURNING customer_id`,
      [`push.${tag}@example.com`],
    );
    customerId = customer!.customer_id;
    customerAuth = `Bearer ${signCustomerToken(customerId, 0)}`;
    setPushSenderForTests(fakeFirebase);
  });

  afterEach(async () => {
    await waitForPendingNotifications();
    sent.length = 0;
    unreachable = false;
  });

  afterAll(async () => {
    setPushSenderForTests(undefined);
    const orders = 'SELECT order_id FROM customer_order WHERE customer_id = $1';
    await testQuery('DELETE FROM idempotency_key WHERE customer_id = $1', [customerId]);
    await testQuery(`DELETE FROM order_status_history WHERE order_id IN (${orders})`, [customerId]);
    await testQuery(`DELETE FROM order_item WHERE order_id IN (${orders})`, [customerId]);
    await testQuery('DELETE FROM customer_order WHERE customer_id = $1', [customerId]);
    const products = 'SELECT product_id FROM product WHERE category_id = $1';
    await testQuery(`DELETE FROM product_variant WHERE product_id IN (${products})`, [categoryId]);
    await testQuery('DELETE FROM product WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM product_category WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM device_token WHERE token LIKE $1', [`test-${tag}:%`]);
    await testQuery('DELETE FROM customer WHERE customer_id = $1', [customerId]);
    await testQuery('DELETE FROM announcement WHERE published_by = $1', [adminId]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('registers a phone, linked to the customer only while signed in', async () => {
    const guest = await register('guest');
    expect(guest.status).toBe(200);
    expect(guest.body.data).toEqual({ registered: true, linkedToAccount: false });

    const signedIn = await register('phone', customerAuth);
    expect(signedIn.body.data).toEqual({ registered: true, linkedToAccount: true });
    expect((await deviceRow('phone'))?.customer_id).toBe(customerId);

    // After signing out, the app registers again without a sign-in: the link goes.
    await register('phone');
    expect((await deviceRow('phone'))?.customer_id).toBeNull();
    await register('phone', customerAuth);

    const forged = await register('other', 'Bearer a.b.c');
    expect(forged.status).toBe(401);

    const expo = await request(app)
      .post('/api/v1/devices')
      .send({ token: 'ExponentPushToken[abcdefghijklmnopqrstuv]', platform: 'android' });
    expect(expo.status).toBe(400);
    expect(expo.body.error.fields[0].message).toMatch(/getDevicePushTokenAsync/);
  });

  it('removes a phone that switches notifications off', async () => {
    await register('switch-off');
    const path = `/api/v1/devices/${encodeURIComponent(token('switch-off'))}`;
    const res = await request(app).delete(path);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: true });
    expect(await deviceRow('switch-off')).toBeUndefined();
  });

  it('publishing an announcement reaches the phones, and invalid tokens are removed', async () => {
    await register('reader');
    await register('uninstalled-dead');
    const res = await request(app)
      .post('/api/v1/admin/announcements')
      .set('Authorization', adminAuth)
      .send({
        title: 'Winter blanket drive',
        body: 'Join us this Saturday at the community hall to hand out blankets.',
      });
    expect(res.status).toBe(201);
    await waitForPendingNotifications();

    const tokens = ours(sent.flatMap((batch) => batch.tokens));
    expect(tokens).toEqual(
      expect.arrayContaining([token('reader'), token('guest'), token('phone')]),
    );
    expect(sent[0]!.message).toMatchObject({
      title: 'News: Winter blanket drive',
      data: { type: 'announcement', announcementId: String(res.body.data.announcementId) },
    });
    expect(await deviceRow('uninstalled-dead')).toBeUndefined();
    expect(await deviceRow('reader')).toBeDefined();
  });

  it('with Firebase unreachable, the announcement still publishes', async () => {
    unreachable = true;
    const res = await request(app)
      .post('/api/v1/admin/announcements')
      .set('Authorization', adminAuth)
      .send({ title: 'Pad drive update', body: 'Thank you to everyone who donated this month.' });
    expect(res.status).toBe(201);
    await waitForPendingNotifications();
    const [row] = await testQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM announcement WHERE announcement_id = $1',
      [res.body.data.announcementId],
    );
    expect(row!.n).toBe(1);
  });

  it("an order status change reaches only that customer's phones", async () => {
    const [category] = await testQuery<{ category_id: number }>(
      'INSERT INTO product_category (name) VALUES ($1) RETURNING category_id',
      [`Push test ${tag}`],
    );
    categoryId = category!.category_id;
    const [product] = await testQuery<{ product_id: number }>(
      `INSERT INTO product (category_id, name, price_cents, is_active)
       VALUES ($1, 'Community tee', 25000, true) RETURNING product_id`,
      [categoryId],
    );
    const [variant] = await testQuery<{ variant_id: number }>(
      `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand)
       VALUES ($1, 'M', $2, 5) RETURNING variant_id`,
      [product!.product_id, `PSH-${tag}`],
    );
    const placed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', customerAuth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ variantId: variant!.variant_id, quantity: 1 }],
        recipientName: 'Naledi Mokoena',
        streetAddress: '18 Mofolo Street',
        city: 'Soweto',
        postalCode: '1801',
        phone: '071 234 5678',
        paymentMethod: 'Cash on delivery',
        acceptTerms: true,
      });
    expect(placed.status).toBe(201);
    const [order] = await testQuery<{ order_id: number }>(
      'SELECT order_id FROM customer_order WHERE order_number = $1',
      [placed.body.data.orderNumber],
    );

    const packed = await request(app)
      .patch(`/api/v1/admin/orders/${order!.order_id}/status`)
      .set('Authorization', adminAuth)
      .send({ status: 'Packed' });
    expect(packed.status).toBe(200);
    await waitForPendingNotifications();

    expect(ours(sent.flatMap((batch) => batch.tokens))).toEqual([token('phone')]);
    expect(sent[0]!.message).toEqual({
      title: `Order ${placed.body.data.orderNumber}: Packed with care`,
      body: 'Your order is now: Packed with care.',
      data: { type: 'order', orderNumber: placed.body.data.orderNumber, status: 'Packed' },
    });
  });
});
