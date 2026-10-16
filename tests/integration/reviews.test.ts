import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import type { EmailMessage } from '../../src/services/email';
import { todayInJohannesburg } from '../../src/utils/dates';
import { generateReference } from '../../src/utils/referenceNumber';
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
const tag = randomUUID().slice(0, 8);
let adminId = 0;
let auth = '';
let typeId = 0;
let eventId = 0;
let taskId = 0;

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', auth),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
};

/** A date relative to today in Johannesburg, as YYYY-MM-DD. */
function day(offset: number): string {
  const date = new Date(`${todayInJohannesburg()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

let phoneCounter = 0;
const nextPhone = () => `+277112${String(10000 + ++phoneCounter).slice(-5)}`;

async function newApplication(): Promise<{ id: number; reference: string; phone: string }> {
  const reference = generateReference('VOL');
  const phone = nextPhone();
  const [row] = await testQuery<{ application_id: number }>(
    `INSERT INTO volunteer_application (reference_number, initiative_id, initiative_task_id,
       applicant_name, contact_number, email, status, consent_given_at)
     VALUES ($1, $2, $3, 'Sipho Dlamini', $4, $5, 'Submitted', now()) RETURNING application_id`,
    [reference, eventId, taskId, phone, `sipho.${tag}@example.com`],
  );
  return { id: row!.application_id, reference, phone };
}

async function newRequest(): Promise<number> {
  const [row] = await testQuery<{ request_id: number }>(
    `INSERT INTO assistance_request (reference_number, applicant_name, contact_number, email,
       request_type, description, status, consent_given_at)
     VALUES ($1, 'Thandi Nkosi', $2, $3, 'Food', $4, 'Submitted', now()) RETURNING request_id`,
    [generateReference('REQ'), nextPhone(), `thandi.${tag}@example.com`, `Food please ${tag}`],
  );
  return row!.request_id;
}

const audits = (table: string, id: number) =>
  testQuery<{ action: string; admin_id: number }>(
    'SELECT action, admin_id FROM audit_log WHERE table_name = $1 AND record_id = $2',
    [table, String(id)],
  );

describe.skipIf(!hasTestDatabase)('review queues', () => {
  beforeAll(async () => {
    const [row] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Review Admin', 'staff') RETURNING admin_id`,
      [`test.${tag}`, `test.${tag}@example.com`],
    );
    adminId = row!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`;
    const [type] = await testQuery<{ initiative_type_id: number }>(
      'INSERT INTO initiative_type (type_name) VALUES ($1) RETURNING initiative_type_id',
      [`Review type ${tag}`],
    );
    typeId = type!.initiative_type_id;
    const [event] = await testQuery<{ initiative_id: number }>(
      `INSERT INTO initiative (initiative_type_id, created_by, title, description, start_date,
                               end_date, volunteers_required, status)
       VALUES ($1, $2, $3, 'Test event', $4, $4, true, 'Published') RETURNING initiative_id`,
      [typeId, adminId, `Review drive ${tag}`, day(5)],
    );
    eventId = event!.initiative_id;
    const [task] = await testQuery<{ initiative_task_id: number }>(
      `INSERT INTO initiative_task (initiative_id, task_name, volunteers_needed)
       VALUES ($1, 'Clothing sorting', 4) RETURNING initiative_task_id`,
      [eventId],
    );
    taskId = task!.initiative_task_id;
  });

  afterAll(async () => {
    await testQuery('DELETE FROM volunteer_application WHERE initiative_id = $1', [eventId]);
    await testQuery('DELETE FROM initiative_task WHERE initiative_id = $1', [eventId]);
    await testQuery('DELETE FROM initiative WHERE initiative_id = $1', [eventId]);
    await testQuery('DELETE FROM initiative_type WHERE initiative_type_id = $1', [typeId]);
    await testQuery('DELETE FROM assistance_request WHERE description = $1', [
      `Food please ${tag}`,
    ]);
    await testQuery('DELETE FROM donation_pledge WHERE email = $1', [`naledi.${tag}@example.com`]);
    await testQuery('DELETE FROM enquiry WHERE email = $1', [`ayanda.${tag}@example.org`]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('keeps every queue behind sign-in', async () => {
    for (const path of [
      '/volunteer-applications',
      '/assistance-requests',
      '/donation-pledges',
      '/enquiries',
    ]) {
      expect((await request(app).get(`/api/v1/admin${path}`)).status).toBe(401);
    }
  });

  it('needs a reason to decline (400 on reason)', async () => {
    const { id } = await newApplication();
    const res = await admin.patch(`/volunteer-applications/${id}/decision`, { status: 'Declined' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].field).toBe('reason');
  });

  it('records a decline, emails it, and tracking shows it; deciding again is 409', async () => {
    const { id, reference, phone } = await newApplication();
    const res = await admin.patch(`/volunteer-applications/${id}/decision`, {
      status: 'Declined',
      reason: 'All sorting places are taken.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'Declined',
      decisionReason: 'All sorting places are taken.',
      reviewedBy: { adminId, fullName: 'Review Admin' },
    });
    expect(await audits('volunteer_application', id)).toEqual([
      { action: 'volunteer_application_declined', admin_id: adminId },
    ]);
    expect(outbox.at(-1)).toMatchObject({
      template: 'volunteer-application-declined',
      to: `sipho.${tag}@example.com`,
    });
    expect(outbox.at(-1)?.text).toContain('Reason: All sorting places are taken.');

    const tracked = await request(app)
      .post('/api/v1/track')
      .send({ referenceNumber: reference, phoneLast4: phone.slice(-4) });
    expect(tracked.body.data).toMatchObject({ status: 'Declined', isFinal: true });

    const again = await admin.patch(`/volunteer-applications/${id}/decision`, {
      status: 'Accepted',
    });
    expect(again.status).toBe(409);
  });

  it('shows how full each task is', async () => {
    const { id } = await newApplication();
    const accepted = await admin.patch(`/volunteer-applications/${id}/decision`, {
      status: 'Accepted',
    });
    expect(accepted.status).toBe(200);
    expect(outbox.at(-1)?.template).toBe('volunteer-application-accepted');

    const list = await admin.get(`/volunteer-applications?initiativeId=${eventId}&status=Accepted`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].task).toEqual({
      taskId,
      name: 'Clothing sorting',
      volunteersNeeded: 4,
      accepted: 1,
    });
    // Attendance can't be recorded before the event (it is 5 days away).
    const early = await admin.patch(`/volunteer-applications/${id}/decision`, {
      status: 'Attended',
    });
    expect(early.status).toBe(409);
  });

  it('moves a request to Under review when opened, then approves it', async () => {
    const id = await newRequest();
    const opened = await admin.get(`/assistance-requests/${id}`);
    expect(opened.body.data.status).toBe('Under review');
    expect(opened.headers['cache-control']).toBe('no-store');

    const approved = await admin.patch(`/assistance-requests/${id}/decision`, {
      status: 'Approved',
    });
    expect(approved.body.data.status).toBe('Approved');
    expect(outbox.at(-1)?.template).toBe('assistance-request-approved');
    expect((await audits('assistance_request', id)).map((a) => a.action)).toEqual([
      'assistance_request_opened',
      'assistance_request_approved',
    ]);

    const closeTooSoon = await admin.patch(`/assistance-requests/${id}/decision`, {
      status: 'Closed',
    });
    expect(closeTooSoon.status).toBe(409);
  });

  it('decides pledges and marks enquiries reviewed', async () => {
    const [pledge] = await testQuery<{ pledge_id: number }>(
      `INSERT INTO donation_pledge (reference_number, donor_name, email, contact_number, category,
         description, estimated_value, consent_given_at)
       VALUES ($1, 'Naledi Mokoena', $2, '+27712345678', 'Goods', 'Blankets', 1200, now())
       RETURNING pledge_id`,
      [generateReference('PLG'), `naledi.${tag}@example.com`],
    );
    const accepted = await admin.patch(`/donation-pledges/${pledge!.pledge_id}/status`, {
      status: 'Accepted',
    });
    expect(accepted.body.data).toMatchObject({ status: 'Accepted', estimatedValue: 'R1 200.00' });
    expect(outbox.at(-1)?.template).toBe('donation-pledge-accepted');
    expect(
      (await admin.patch(`/donation-pledges/${pledge!.pledge_id}/status`, { status: 'Accepted' }))
        .status,
    ).toBe(409);

    const [enquiry] = await testQuery<{ enquiry_id: number }>(
      `INSERT INTO enquiry (contact_name, email, enquiry_type, message, status, consent_given_at)
       VALUES ('Ayanda Zulu', $1, 'Partner', 'We would like to sponsor.', 'New', now())
       RETURNING enquiry_id`,
      [`ayanda.${tag}@example.org`],
    );
    const reviewed = await admin.patch(`/enquiries/${enquiry!.enquiry_id}/status`, {
      status: 'Reviewed',
    });
    expect(reviewed.body.data.status).toBe('Reviewed');
    expect(await audits('enquiry', enquiry!.enquiry_id)).toEqual([
      { action: 'enquiry_reviewed', admin_id: adminId },
    ]);
  });

  it('only sorts by the allowed orders', async () => {
    const res = await admin.get(
      `/volunteer-applications?sort=${encodeURIComponent('applicant_name; DROP TABLE x')}`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
