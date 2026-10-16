import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import type { EmailMessage } from '../../src/services/email';
import { generateReference } from '../../src/utils/referenceNumber';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Emails land in this list instead of being sent.
const outbox = vi.hoisted(() => [] as Array<{ template: string; to: string }>);
vi.mock('../../src/services/email', () => ({
  sendEmailInBackground: (message: EmailMessage, template: string) => {
    outbox.push({ template, to: message.to });
  },
}));

const app = createApp();
const tag = randomUUID().slice(0, 8);
const itemIds: number[] = [];
let adminId = 0;
let auth = '';

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', auth),
  post: (path: string, body: object) =>
    request(app).post(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
};

async function newItem(name: string, openingQuantity = 0): Promise<number> {
  const res = await admin.post('/stock-items', {
    name: `${name} ${tag}`,
    category: 'Bedding',
    unit: 'blanket',
    reorderLevel: 2,
    openingQuantity,
  });
  expect(res.status).toBe(201);
  itemIds.push(res.body.data.stockItemId);
  return res.body.data.stockItemId;
}

const onHand = async (itemId: number) =>
  (await admin.get(`/stock-items/${itemId}`)).body.data.quantityOnHand as number;

/** Increases minus decreases, straight from the movement history. */
async function movementTotal(itemId: number): Promise<number> {
  const [row] = await testQuery<{ total: number }>(
    `SELECT COALESCE(sum(CASE movement_type WHEN 'Increase' THEN quantity
                                            ELSE -quantity END), 0)::int AS total
     FROM stock_movement WHERE stock_item_id = $1`,
    [itemId],
  );
  return row!.total;
}

let phoneCounter = 0;
async function approvedRequest(): Promise<number> {
  const [row] = await testQuery<{ request_id: number }>(
    `INSERT INTO assistance_request (reference_number, applicant_name, contact_number, request_type,
       description, status, reviewed_by, reviewed_date, consent_given_at)
     VALUES ($1, 'Thandi Nkosi', $2, 'Blankets', $3, 'Approved', $4, now(), now())
     RETURNING request_id`,
    [
      generateReference('REQ'),
      `+2771200${String(1000 + ++phoneCounter).slice(-4)}`,
      `Blankets please ${tag}`,
      adminId,
    ],
  );
  return row!.request_id;
}

describe.skipIf(!hasTestDatabase)('donations and stock', () => {
  beforeAll(async () => {
    const [row] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Stock Admin', 'staff') RETURNING admin_id`,
      [`test.${tag}`, `test.${tag}@example.com`],
    );
    adminId = row!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`;
  });

  afterAll(async () => {
    await testQuery('DELETE FROM stock_movement WHERE recorded_by = $1', [adminId]);
    await testQuery('DELETE FROM donation WHERE recorded_by = $1', [adminId]);
    await testQuery('DELETE FROM donation_pledge WHERE email = $1', [`naledi.${tag}@example.com`]);
    await testQuery('DELETE FROM assistance_request WHERE description = $1', [
      `Blankets please ${tag}`,
    ]);
    await testQuery('DELETE FROM stock_item WHERE stock_item_id = ANY($1)', [itemIds]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('raises stock by exactly the quantity of a goods donation', async () => {
    const itemId = await newItem('Blankets', 5);
    const res = await admin.post('/donations', {
      type: 'Goods',
      donorName: 'Pick n Pay Soweto',
      stockItemId: itemId,
      quantity: 12,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'Goods', quantity: 12, amount: null });
    expect(await onHand(itemId)).toBe(17);
    expect(await movementTotal(itemId)).toBe(17);
  });

  it('saves nothing when something fails halfway', async () => {
    const itemId = await newItem('Overflow');
    // A quantity so close to the database's limit that adding stock fails at the very end.
    await testQuery(
      'UPDATE stock_item SET quantity_on_hand = 2147483600 WHERE stock_item_id = $1',
      [itemId],
    );
    const res = await admin.post('/donations', {
      type: 'Goods',
      donorName: 'Big Donor',
      stockItemId: itemId,
      quantity: 100,
    });
    expect(res.status).toBe(400);
    const found = (table: string) =>
      testQuery(`SELECT 1 FROM ${table} WHERE stock_item_id = $1`, [itemId]);
    expect(await found('donation')).toEqual([]);
    expect(await found('stock_movement')).toEqual([]);
  });

  it('rejects a monetary donation with a quantity', async () => {
    const res = await admin.post('/donations', {
      type: 'Monetary',
      donorName: 'Naledi Mokoena',
      amount: 250,
      quantity: 3,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual([
      {
        field: 'quantity',
        message: 'A monetary donation has no quantity. Record goods as a goods donation.',
      },
    ]);
  });

  it('lets only one of two fulfilments at once have the last 5 blankets', async () => {
    const itemId = await newItem('Last blankets', 5);
    const [first, second] = [await approvedRequest(), await approvedRequest()];
    const fulfil = (requestId: number) =>
      admin.post(`/assistance-requests/${requestId}/fulfil`, {
        items: [{ stockItemId: itemId, quantity: 5 }],
      });
    const replies = await Promise.all([fulfil(first), fulfil(second)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const refused = replies.find((reply) => reply.status === 409)!;
    expect(refused.body.error.message).toContain(`Last blankets ${tag}`);
    expect(await onHand(itemId)).toBe(0);
    expect(await movementTotal(itemId)).toBe(0);
  });

  it('refuses to void a donation whose goods were already given out', async () => {
    const itemId = await newItem('Food parcels');
    const donation = await admin.post('/donations', {
      type: 'Goods',
      donorName: 'Spar Orlando',
      stockItemId: itemId,
      quantity: 10,
    });
    const requestId = await approvedRequest();
    const given = await admin.post(`/assistance-requests/${requestId}/fulfil`, {
      items: [{ stockItemId: itemId, quantity: 4 }],
    });
    expect(given.body.data.request.status).toBe('Fulfilled');

    const voided = await admin.post(`/donations/${donation.body.data.donationId}/void`, {
      reason: 'Recorded twice',
    });
    expect(voided.status).toBe(409);
    expect(voided.body.error.message).toMatch(/already been given out/);
    expect(await onHand(itemId)).toBe(6);
  });

  it('voids a donation by reversing its stock and keeping the record', async () => {
    const itemId = await newItem('Pads');
    const donation = await admin.post('/donations', {
      type: 'Goods',
      donorName: 'Clicks Jabulani',
      stockItemId: itemId,
      quantity: 7,
    });
    const voided = await admin.post(`/donations/${donation.body.data.donationId}/void`, {
      reason: 'Recorded on the wrong item',
    });
    expect(voided.status).toBe(200);
    expect(voided.body.data.voided).toMatchObject({ reason: 'Recorded on the wrong item' });
    expect(await onHand(itemId)).toBe(0);
    expect(await movementTotal(itemId)).toBe(0);
  });

  it('turns an accepted pledge into a donation and thanks the donor', async () => {
    const itemId = await newItem('Winter blankets');
    const [pledge] = await testQuery<{ pledge_id: number }>(
      `INSERT INTO donation_pledge (reference_number, donor_name, email, contact_number, category,
         description, status, reviewed_by, reviewed_date, consent_given_at)
       VALUES ($1, 'Naledi Mokoena', $2, '+27712345678', 'Goods', 'Blankets', 'Accepted', $3,
               now(), now())
       RETURNING pledge_id`,
      [generateReference('PLG'), `naledi.${tag}@example.com`, adminId],
    );
    const res = await admin.post(`/donation-pledges/${pledge!.pledge_id}/receive`, {
      stockItemId: itemId,
      quantity: 8,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.pledge.status).toBe('Received');
    expect(res.body.data.donation).toMatchObject({ type: 'Goods', donorName: 'Naledi Mokoena' });
    expect(await onHand(itemId)).toBe(8);
    expect(outbox.at(-1)).toEqual({
      template: 'donation-pledge-received',
      to: `naledi.${tag}@example.com`,
    });

    const again = await admin.post(`/donation-pledges/${pledge!.pledge_id}/receive`, {
      stockItemId: itemId,
      quantity: 8,
    });
    expect(again.status).toBe(409);
  });

  it("keeps every item's movements equal to its quantity on hand", async () => {
    for (const itemId of itemIds.filter((_, index) => index !== 1)) {
      expect(await movementTotal(itemId)).toBe(await onHand(itemId));
    }
    const history = await admin.get(`/stock-items/${itemIds[0]}/movements`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((m: { source: { kind: string } }) => m.source.kind)).toEqual([
      'donation',
      'adjustment',
    ]);
  });
});
