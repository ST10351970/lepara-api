import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import type { EmailMessage } from '../../src/services/email';
import { todayInJohannesburg } from '../../src/utils/dates';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Emails land in this list instead of being sent.
const outbox = vi.hoisted(() => [] as Array<{ template: string; to: string; subject: string }>);
vi.mock('../../src/services/email', () => ({
  sendEmailInBackground: (message: EmailMessage, template: string) => {
    outbox.push({ template, to: message.to, subject: message.subject });
  },
}));

// The 5-forms-per-10-minutes limit is switched on only for the test about it.
const limit = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/middleware/rateLimiters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/rateLimiters')>();
  type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;
  const passThrough: Middleware = (_req, _res, next) => next();
  const realFormLimit = actual.limiters.publicForms as unknown as Middleware;
  return {
    ...actual,
    limiters: {
      ...actual.limiters,
      global: passThrough,
      publicForms: (req: unknown, res: unknown, next: () => void) =>
        limit.on ? realFormLimit(req, res, next) : next(),
    },
  };
});

const app = createApp();
const tag = randomUUID().slice(0, 8);
const events: number[] = [];
let adminId = 0;
let typeId = 0;
let openEvent = 0;
let openTask = 0;
let draftEvent = 0;
let endedEvent = 0;

/** A date relative to today in Johannesburg, as YYYY-MM-DD. */
function day(offset: number): string {
  const date = new Date(`${todayInJohannesburg()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function newEvent(status: string, start: number, end: number): Promise<number> {
  const [row] = await testQuery<{ initiative_id: number }>(
    `INSERT INTO initiative (initiative_type_id, created_by, title, description, location,
                             start_date, end_date, volunteers_required, status)
     VALUES ($1, $2, $3, 'Test event', 'Soweto', $4, $5, true, $6) RETURNING initiative_id`,
    [typeId, adminId, `Clothing drive ${tag}`, day(start), day(end), status],
  );
  events.push(row!.initiative_id);
  return row!.initiative_id;
}

const post = (path: string, body: object) => request(app).post(`/api/v1${path}`).send(body);

/** A different valid phone number for each test, so pending applications don't collide. */
let phoneCounter = 0;
const phoneMiddle = tag.replace(/\D/g, '').padEnd(3, '5').slice(0, 3);
const nextPhone = () => `071 ${phoneMiddle} ${1000 + ++phoneCounter}`;

const volunteer = (body: object = {}) => ({
  initiativeId: openEvent,
  taskId: openTask,
  fullName: 'Sipho Dlamini',
  phone: nextPhone(),
  email: `sipho.${tag}@example.com`,
  contribution: 'I can sort by size and prepare bundles.',
  availability: 'Saturday, 10:00–14:00',
  consent: true,
  ...body,
});

const pledge = (body: object = {}) => ({
  fullName: 'Naledi Mokoena',
  email: `naledi.${tag}@example.com`,
  phone: '071 234 5678',
  category: 'Goods',
  description: '12 clean blankets for the clothing drive.',
  estimatedValue: '1200',
  consent: true,
  ...body,
});

const assistance = (body: object = {}) => ({
  fullName: 'Thandi Nkosi',
  phone: '082 555 0101',
  requestType: 'Blankets',
  description: `Two blankets for my grandmother, please. ${tag}`,
  consent: true,
  ...body,
});

const enquiry = (body: object = {}) => ({
  fullName: 'Ayanda Zulu',
  email: `ayanda.${tag}@example.org`,
  enquiryType: 'Partner',
  message: 'Our company would like to sponsor the winter drive.',
  consent: true,
  ...body,
});

describe.skipIf(!hasTestDatabase)('public forms', () => {
  beforeAll(async () => {
    const [admin] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Forms Admin', 'staff') RETURNING admin_id`,
      [`test.${tag}`, `test.${tag}@example.com`],
    );
    adminId = admin!.admin_id;
    const [type] = await testQuery<{ initiative_type_id: number }>(
      'INSERT INTO initiative_type (type_name) VALUES ($1) RETURNING initiative_type_id',
      [`Forms type ${tag}`],
    );
    typeId = type!.initiative_type_id;

    openEvent = await newEvent('Published', 3, 3);
    const [task] = await testQuery<{ initiative_task_id: number }>(
      `INSERT INTO initiative_task (initiative_id, task_name) VALUES ($1, 'Clothing sorting')
       RETURNING initiative_task_id`,
      [openEvent],
    );
    openTask = task!.initiative_task_id;
    draftEvent = await newEvent('Draft', 3, 3);
    endedEvent = await newEvent('Published', -3, -1);
  });

  afterAll(async () => {
    await testQuery('DELETE FROM volunteer_application WHERE initiative_id = ANY($1)', [events]);
    await testQuery('DELETE FROM donation_pledge WHERE email = $1', [`naledi.${tag}@example.com`]);
    await testQuery('DELETE FROM assistance_request WHERE description LIKE $1', [`%${tag}`]);
    await testQuery('DELETE FROM enquiry WHERE email = $1', [`ayanda.${tag}@example.org`]);
    await testQuery('DELETE FROM initiative_task WHERE initiative_id = ANY($1)', [events]);
    await testQuery('DELETE FROM initiative WHERE initiative_id = ANY($1)', [events]);
    await testQuery('DELETE FROM initiative_type WHERE initiative_type_id = $1', [typeId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('takes a volunteer application and emails the reference number', async () => {
    const res = await post('/volunteer-applications', volunteer());
    expect(res.status).toBe(201);
    const reference = res.body.data.referenceNumber;
    expect(reference).toMatch(/^VOL-[A-Z2-9]{6}$/);
    expect(res.body.data).toMatchObject({ status: 'Submitted' });
    expect(res.body.data.message).toContain(reference);

    const [row] = await testQuery<{ initiative_task_id: number; consent_given_at: Date | null }>(
      `SELECT initiative_task_id, consent_given_at FROM volunteer_application
       WHERE reference_number = $1`,
      [reference],
    );
    expect(row!.initiative_task_id).toBe(openTask);
    expect(row!.consent_given_at).toBeInstanceOf(Date);
    expect(outbox.at(-1)).toEqual({
      template: 'volunteer-application-received',
      to: `sipho.${tag}@example.com`,
      subject: `Volunteer application received: ${reference}`,
    });
  });

  it('refuses drafts and ended events kindly', async () => {
    const draft = await post('/volunteer-applications', volunteer({ initiativeId: draftEvent }));
    expect(draft.status).toBe(400);
    expect(draft.body.error.fields).toEqual([
      { field: 'initiativeId', message: 'Please choose one of the upcoming events.' },
    ]);
    const ended = await post('/volunteer-applications', volunteer({ initiativeId: endedEvent }));
    expect(ended.status).toBe(400);
    expect(ended.body.error.fields[0].message).toMatch(/already ended/);
    const pledgeForEnded = await post('/donation-pledges', pledge({ initiativeId: endedEvent }));
    expect(pledgeForEnded.status).toBe(400);
  });

  it('allows one pending application per phone number per event', async () => {
    const body = volunteer();
    expect((await post('/volunteer-applications', body)).status).toBe(201);
    const again = await post('/volunteer-applications', body);
    expect(again.status).toBe(409);
    expect(again.body.error.fields[0].field).toBe('phone');
  });

  it('takes a donation pledge, with or without an event', async () => {
    const general = await post('/donation-pledges', pledge());
    expect(general.status).toBe(201);
    expect(general.body.data).toMatchObject({ status: 'Pending' });
    const forEvent = await post('/donation-pledges', pledge({ initiativeId: openEvent }));
    expect(forEvent.status).toBe(201);

    const [row] = await testQuery<{ estimated_value: string; initiative_id: number }>(
      'SELECT estimated_value, initiative_id FROM donation_pledge WHERE reference_number = $1',
      [forEvent.body.data.referenceNumber],
    );
    expect(row).toEqual({ estimated_value: '1200.00', initiative_id: openEvent });
    expect(outbox.at(-1)?.subject).toBe(
      `Donation pledge received: ${forEvent.body.data.referenceNumber}`,
    );
  });

  it('takes an assistance request; no email address means no email', async () => {
    const before = outbox.length;
    const res = await post('/assistance-requests', assistance());
    expect(res.status).toBe(201);
    expect(res.body.data.referenceNumber).toMatch(/^REQ-/);
    expect(outbox.length).toBe(before);
  });

  it('takes an enquiry, which has no reference number', async () => {
    const res = await post('/enquiries', enquiry());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ referenceNumber: null, status: 'New' });
    expect(outbox.at(-1)?.template).toBe('enquiry-received');
  });

  it('needs the consent box ticked', async () => {
    const forms: Array<[string, object]> = [
      ['/volunteer-applications', volunteer({ consent: false })],
      ['/donation-pledges', pledge({ consent: false })],
      ['/assistance-requests', assistance({ consent: undefined })],
      ['/enquiries', enquiry({ consent: 'yes' })],
    ];
    for (const [path, body] of forms) {
      const res = await post(path, body);
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual([
        { field: 'consent', message: 'Please tick the box to agree before sending.' },
      ]);
    }
  });

  it('gives bots that fill in the hidden field a pretend success and saves nothing', async () => {
    const before = outbox.length;
    const res = await post(
      '/assistance-requests',
      assistance({ website: 'https://spam.example', fullName: 'Spam Bot' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.referenceNumber).toMatch(/^REQ-/);
    const rows = await testQuery('SELECT 1 FROM assistance_request WHERE reference_number = $1', [
      res.body.data.referenceNumber,
    ]);
    expect(rows).toEqual([]);
    expect(outbox.length).toBe(before);
  });

  it('lists the choices for the forms', async () => {
    const res = await request(app).get('/api/v1/form-options');
    expect(res.status).toBe(200);
    expect(res.body.data.enquiryTypes.map((option: { value: string }) => option.value)).toEqual([
      'Donor',
      'Partner',
    ]);
    expect(res.body.data.donationCategories).toHaveLength(4);
  });

  // Last, because it uses up this IP address's allowance.
  it('answers the 6th form in 10 minutes with 429', async () => {
    limit.on = true;
    const bot = enquiry({ website: 'filled in' }); // saves nothing, but still counts
    for (let i = 0; i < 5; i += 1) {
      expect((await post('/enquiries', bot)).status).toBe(201);
    }
    const sixth = await post('/volunteer-applications', volunteer());
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    limit.on = false;
  });
});
