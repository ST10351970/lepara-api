import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { generateReference } from '../../src/utils/referenceNumber';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// The 5-wrong-tries limit is switched on only for the test about it.
const limit = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/middleware/rateLimiters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/rateLimiters')>();
  type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;
  const passThrough: Middleware = (_req, _res, next) => next();
  const realTrackingLimit = actual.limiters.tracking as unknown as Middleware;
  return {
    ...actual,
    limiters: {
      ...actual.limiters,
      global: passThrough,
      tracking: (req: unknown, res: unknown, next: () => void) =>
        limit.on ? realTrackingLimit(req, res, next) : next(),
    },
  };
});

const app = createApp();
const tag = randomUUID().slice(0, 8);
const NAME = 'Thandi Nkosi';
const EMAIL = `tracking.${tag}@example.com`;
const PHONE = '+27712345678';
const DESCRIPTION = `Private details for tracking test ${tag}`;
const NO_MATCH = "We couldn't find a match. Please check your reference number and phone number.";

let adminId = 0;
let typeId = 0;
let initiativeId = 0;
const ref = {
  request: generateReference('REQ'),
  volunteer: generateReference('VOL'),
  pledge: generateReference('PLG'),
};

const track = (referenceNumber: string, phoneLast4: string) =>
  request(app).post('/api/v1/track').send({ referenceNumber, phoneLast4 });

/** The reply without its request ID, which differs on every request. */
function withoutRequestId(body: { error?: { requestId?: string } }) {
  const copy = structuredClone(body);
  delete copy.error?.requestId;
  return copy;
}

describe.skipIf(!hasTestDatabase)('tracking', () => {
  beforeAll(async () => {
    const [admin] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Tracking Admin', 'staff') RETURNING admin_id`,
      [`test.${tag}`, `admin.${tag}@example.com`],
    );
    adminId = admin!.admin_id;
    const [type] = await testQuery<{ initiative_type_id: number }>(
      'INSERT INTO initiative_type (type_name) VALUES ($1) RETURNING initiative_type_id',
      [`Tracking type ${tag}`],
    );
    typeId = type!.initiative_type_id;
    const [event] = await testQuery<{ initiative_id: number }>(
      `INSERT INTO initiative (initiative_type_id, created_by, title, description, start_date,
                               end_date, volunteers_required, status)
       VALUES ($1, $2, 'Tracking drive', 'Test event', '2026-12-01', '2026-12-01', true,
               'Published') RETURNING initiative_id`,
      [typeId, adminId],
    );
    initiativeId = event!.initiative_id;

    await testQuery(
      `INSERT INTO assistance_request (reference_number, applicant_name, contact_number, email,
                                       request_type, description, status, consent_given_at)
       VALUES ($1, $2, $3, $4, 'Food', $5, 'Submitted', now())`,
      [ref.request, NAME, PHONE, EMAIL, DESCRIPTION],
    );
    await testQuery(
      `INSERT INTO volunteer_application (reference_number, initiative_id, applicant_name,
                                          contact_number, email, status, consent_given_at)
       VALUES ($1, $2, $3, $4, $5, 'Submitted', now())`,
      [ref.volunteer, initiativeId, NAME, PHONE, EMAIL],
    );
    await testQuery(
      `INSERT INTO donation_pledge (reference_number, donor_name, email, contact_number, category,
                                    description, consent_given_at)
       VALUES ($1, $2, $3, $4, 'Goods', $5, now())`,
      [ref.pledge, NAME, EMAIL, PHONE, DESCRIPTION],
    );
  });

  afterAll(async () => {
    await testQuery('DELETE FROM assistance_request WHERE reference_number = $1', [ref.request]);
    await testQuery('DELETE FROM volunteer_application WHERE initiative_id = $1', [initiativeId]);
    await testQuery('DELETE FROM donation_pledge WHERE reference_number = $1', [ref.pledge]);
    await testQuery('DELETE FROM initiative WHERE initiative_id = $1', [initiativeId]);
    await testQuery('DELETE FROM initiative_type WHERE initiative_type_id = $1', [typeId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('shows the status for the right reference and digits', async () => {
    const res = await track(ref.request.toLowerCase(), '5678');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      referenceNumber: ref.request,
      type: 'assistance_request',
      typeLabel: 'Request for help',
      status: 'Submitted',
      isFinal: false,
    });
    expect(res.body.data.statusMessage).toMatch(/waiting for review/);
    expect(res.headers['cache-control']).toBe('no-store');

    expect((await track(ref.volunteer, '5678')).body.data.type).toBe('volunteer_application');
    expect((await track(ref.pledge, '5678')).body.data.status).toBe('Pending');
  });

  it('never includes names, contact details or descriptions', async () => {
    for (const reference of [ref.request, ref.volunteer, ref.pledge]) {
      const reply = JSON.stringify((await track(reference, '5678')).body);
      for (const secret of [NAME, EMAIL, PHONE, DESCRIPTION, 'Tracking drive']) {
        expect(reply).not.toContain(secret);
      }
    }
  });

  it('gives the same reply for a wrong reference and wrong digits', async () => {
    const wrongDigits = await track(ref.request, '5679');
    const wrongReference = await track(generateReference('REQ'), '5678');
    expect(wrongDigits.status).toBe(404);
    expect(wrongReference.status).toBe(404);
    expect(withoutRequestId(wrongDigits.body)).toEqual(withoutRequestId(wrongReference.body));
    expect(wrongDigits.body.error).toMatchObject({ code: 'NOT_FOUND', message: NO_MATCH });
  });

  it('shows a decision as soon as it is made', async () => {
    const reviewed = new Date('2026-10-20T09:15:00.000Z');
    await testQuery(
      `UPDATE assistance_request SET status = 'Approved', reviewed_by = $2, reviewed_date = $3
       WHERE reference_number = $1`,
      [ref.request, adminId, reviewed],
    );
    const res = await track(ref.request, '5678');
    expect(res.body.data.status).toBe('Approved');
    expect(res.body.data.lastUpdatedAt).toBe(reviewed.toISOString());
    expect(res.body.data.submittedAt).not.toBe(reviewed.toISOString());
  });

  // Last, because it uses up this IP address's allowance.
  it('answers the 6th wrong attempt with 429', async () => {
    limit.on = true;
    for (let i = 0; i < 5; i += 1) {
      expect((await track(ref.pledge, '0000')).status).toBe(404);
    }
    const sixth = await track(ref.pledge, '5678'); // even the right digits, once blocked
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    limit.on = false;
  });
});
