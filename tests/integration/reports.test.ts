import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken as signAdminToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import {
  signAccessToken as signCustomerToken,
} from '../../src/modules/customerAuth/customerAuth.tokens';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

/**
 * Reports checked against a hand count. The test data is dated July 2032, so
 * nothing else in the test database falls in that range.
 */

const app = createApp();
const tag = randomUUID().slice(0, 6).toUpperCase();
const JULY = 'from=2032-07-01&to=2032-07-31';
let adminId = 0;
let adminAuth = '';
let customerId = 0;
let stockItemId = 0;
let categoryId = 0;

const report = (path: string) =>
  request(app).get(`/api/v1/admin${path}`).set('Authorization', adminAuth);

async function one(sql: string, values: unknown[]): Promise<number> {
  const [row] = await testQuery<{ id: number }>(sql, values);
  return row!.id;
}

describe.skipIf(!hasTestDatabase)('dashboard and reports', () => {
  beforeAll(async () => {
    const username = `reports.${tag.toLowerCase()}`;
    adminId = await one(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Report Admin', 'staff') RETURNING admin_id AS id`,
      [username, `${username}@example.com`],
    );
    adminAuth = `Bearer ${signAdminToken(adminId, 0)}`;

    stockItemId = await one(
      `INSERT INTO stock_item (item_name, unit_of_measure, quantity_on_hand, reorder_level)
       VALUES ($1, 'blanket', 20, 5) RETURNING stock_item_id AS id`,
      [`Report blankets ${tag}`],
    );
    const donation = (
      donor: string,
      type: string,
      amount: string | null,
      quantity: number | null,
    ) =>
      one(
        `INSERT INTO donation (recorded_by, stock_item_id, donor_name, is_anonymous, donation_type,
           amount, quantity, date_received)
         VALUES ($1, $2, $3, false, $4, $5, $6, '2032-07-10') RETURNING donation_id AS id`,
        [adminId, type === 'Goods' ? stockItemId : null, donor, type, amount, quantity],
      );
    await donation('Thabo Nkosi', 'Monetary', '250.00', null);
    await donation('=HYPERLINK("http://evil.example","Click")', 'Monetary', '1000.50', null);
    const voided = await donation('Entered twice', 'Monetary', '99.99', null);
    await testQuery(
      `UPDATE donation SET voided_at = now(), voided_by = $1, void_reason = 'Duplicate'
       WHERE donation_id = $2`,
      [adminId, voided],
    );
    const goods = await donation('Church group', 'Goods', null, 20);
    await testQuery(
      `INSERT INTO stock_movement (stock_item_id, donation_id, recorded_by, movement_type, quantity,
         movement_date)
       VALUES ($1, $2, $3, 'Increase', 20, '2032-07-10 10:00+02')`,
      [stockItemId, goods, adminId],
    );

    const requestRow = (status: string, n: number) =>
      testQuery(
        `INSERT INTO assistance_request (reference_number, applicant_name, contact_number,
           request_type, description, status, consent_given_at, submitted_date, decision_reason)
         VALUES ($1, 'Applicant', '+27719999999', 'Clothing', 'Needs warm clothing', $2, now(),
           '2032-07-12 09:00+02', $3)`,
        [`REQ-${tag}${n}`, status, status === 'Declined' ? 'Out of area' : null],
      );
    await requestRow('Submitted', 1);
    await requestRow('Declined', 2);

    customerId = await one(
      `INSERT INTO customer (first_name, last_name, email, mobile, password_hash, terms_accepted_at)
       VALUES ('Naledi', 'Mokoena', $1, '+27712345678', 'not-used', now())
       RETURNING customer_id AS id`,
      [`reports.${tag}@example.com`],
    );
    categoryId = await one(
      'INSERT INTO product_category (name) VALUES ($1) RETURNING category_id AS id',
      [`Reports ${tag}`],
    );
    const productId = await one(
      `INSERT INTO product (category_id, name, price_cents, is_active)
       VALUES ($1, 'Community tee', 25000, true) RETURNING product_id AS id`,
      [categoryId],
    );
    const variantId = await one(
      `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand)
       VALUES ($1, 'M', $2, 10) RETURNING variant_id AS id`,
      [productId, `RPT-${tag}`],
    );
    for (const [status, payment] of [
      ['Confirmed', 'Unpaid'],
      ['Cancelled', 'Unpaid'],
    ]) {
      const orderId = await one(
        `INSERT INTO customer_order (customer_id, status, payment_method, payment_status,
           recipient_name, street_address, city, postal_code, phone, subtotal_cents,
           delivery_cents, total_cents, created_at)
         VALUES ($1, $2, 'Cash on delivery', $3, 'N', 'S', 'C', '1801', '+27712345678', 25000,
           6000, 31000, '2032-07-15 12:00+02') RETURNING order_id AS id`,
        [customerId, status, payment],
      );
      await testQuery(
        `INSERT INTO order_item (order_id, variant_id, product_name, size, unit_price_cents,
           quantity, line_total_cents)
         VALUES ($1, $2, 'Community tee', 'M', 25000, 1, 25000)`,
        [orderId, variantId],
      );
    }
  });

  afterAll(async () => {
    const orders = 'SELECT order_id FROM customer_order WHERE customer_id = $1';
    await testQuery(`DELETE FROM order_item WHERE order_id IN (${orders})`, [customerId]);
    await testQuery('DELETE FROM customer_order WHERE customer_id = $1', [customerId]);
    await testQuery('DELETE FROM customer WHERE customer_id = $1', [customerId]);
    const products = 'SELECT product_id FROM product WHERE category_id = $1';
    await testQuery(`DELETE FROM product_variant WHERE product_id IN (${products})`, [categoryId]);
    await testQuery('DELETE FROM product WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM product_category WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM assistance_request WHERE reference_number LIKE $1', [
      `REQ-${tag}%`,
    ]);
    await testQuery('DELETE FROM stock_movement WHERE recorded_by = $1', [adminId]);
    await testQuery('DELETE FROM donation WHERE recorded_by = $1', [adminId]);
    await testQuery('DELETE FROM stock_item WHERE stock_item_id = $1', [stockItemId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('donation totals match a hand count (the voided one is left out)', async () => {
    const res = await report(`/reports/donations?${JULY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({
      donationCount: 3,
      donorCount: 3,
      monetaryCount: 2,
      monetaryTotal: { cents: 125050, label: 'R1 250.50' },
      monetaryAverage: { cents: 62525, label: 'R625.25' },
      goodsCount: 1,
    });
    expect(res.body.data.goodsByItem).toEqual([
      expect.objectContaining({ itemName: `Report blankets ${tag}`, quantity: 20 }),
    ]);
  });

  it('a date range with no data returns zeros, not an error', async () => {
    const res = await report('/reports/donations?from=2032-01-01&to=2032-01-31');
    expect(res.status).toBe(200);
    expect(res.body.data.summary.donationCount).toBe(0);
    expect(res.body.data.summary.monetaryAverage).toEqual({ cents: 0, label: 'R0.00' });
    const sales = await report('/reports/sales?from=2032-01-01&to=2032-01-31');
    expect(sales.body.data.summary.averageOrder.cents).toBe(0);
  });

  it('an end date before the start date gets 400', async () => {
    const res = await report('/reports/sales?from=2032-07-31&to=2032-07-01');
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0]).toEqual({
      field: 'to',
      message: 'The end date must be on or after the start date.',
    });
  });

  it('the CSV downloads, and a donor name starting with = is plain text', async () => {
    const res = await report(`/reports/donations?${JULY}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="donations_2032-07-01_to_2032-07-31.csv"',
    );
    const lines: string[] = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines.find((line) => line.includes('HYPERLINK'))).toContain(
      `"'=HYPERLINK(""http://evil.example"",""Click"")",No,"Monetary",1000.50`,
    );
  });

  it('stock, assistance requests and sales add up', async () => {
    const stock = await report(`/reports/stock?${JULY}`);
    const item = stock.body.data.items.find(
      (row: { stockItemId: number }) => row.stockItemId === stockItemId,
    );
    expect(item).toMatchObject({
      opening: 0,
      received: 20,
      givenOut: 0,
      closing: 20,
      isLow: false,
    });

    const requests = await report(`/reports/assistance-requests?${JULY}`);
    expect(requests.body.data.total).toMatchObject({
      total: 2,
      submitted: 1,
      declined: 1,
      approvedPercent: 0,
    });

    const sales = await report(`/reports/sales?${JULY}`);
    expect(sales.body.data.summary).toMatchObject({
      orderCount: 2,
      cancelledCount: 1,
      itemsSold: 1,
      salesTotal: { cents: 31000, label: 'R310.00' },
      unpaidTotal: { cents: 31000, label: 'R310.00' },
    });
  });

  it('the dashboard answers for any admin, and never for a customer', async () => {
    const res = await report('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.orders.toPack).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.data.donationsThisMonth.monetaryTotal.cents).toBe('number');

    const customer = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${signCustomerToken(customerId, 0)}`);
    expect(customer.status).toBe(401);
  });
});
