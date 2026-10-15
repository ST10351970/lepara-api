import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { MAX_IMAGE_BYTES } from '../../src/middleware/upload';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { todayInJohannesburg } from '../../src/utils/dates';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Photos go to a pretend storage here, so the tests need no Azure account.
const storage = vi.hoisted(() => ({ ready: true, saved: [] as string[], deleted: [] as string[] }));
vi.mock('../../src/services/imageStorage', () => ({
  imageStorageReady: () => storage.ready,
  saveImage: async (_image: unknown, folder: string) => {
    const url = `https://test.blob.core.windows.net/images/${folder}/${storage.saved.length + 1}.png`;
    storage.saved.push(url);
    return url;
  },
  deleteImage: async (url: string | null) => {
    if (url) storage.deleted.push(url);
  },
}));

const app = createApp();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const typeIds: number[] = [];
let adminId = 0;
let auth = '';

/** A date relative to today in Johannesburg, as YYYY-MM-DD. */
function day(offset: number): string {
  const date = new Date(`${todayInJohannesburg()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', auth),
  post: (path: string, body: object = {}) =>
    request(app).post(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
  delete: (path: string) => request(app).delete(`/api/v1/admin${path}`).set('Authorization', auth),
};
const publicApi = (path: string) => request(app).get(`/api/v1${path}`);

/** A fresh event type per test, so each test's public list holds only its own events. */
async function newType(): Promise<number> {
  const res = await admin.post('/initiative-types', {
    name: `Test type ${randomUUID().slice(0, 8)}`,
  });
  expect(res.status).toBe(201);
  typeIds.push(res.body.data.typeId);
  return res.body.data.typeId;
}

async function newDraft(typeId: number, overrides: object = {}): Promise<number> {
  const res = await admin.post('/initiatives', {
    typeId,
    title: 'Community clothing drive',
    description: 'Help sort clothing, prepare donation bundles and welcome neighbours.',
    startDate: day(3),
    endDate: day(3),
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.data.initiativeId;
}

/** Sets a status directly, for dates that the publish rules wouldn't allow (events in the past). */
async function forceStatus(initiativeId: number, status: string): Promise<void> {
  await testQuery('UPDATE initiative SET status = $2 WHERE initiative_id = $1', [
    initiativeId,
    status,
  ]);
}

describe.skipIf(!hasTestDatabase)('events', () => {
  beforeAll(async () => {
    const username = `test.${randomUUID().slice(0, 8)}`;
    const [row] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Events Admin', 'staff') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = row!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`; // staff can manage events
  });

  afterAll(async () => {
    if (typeIds.length > 0) {
      const events = await testQuery<{ initiative_id: number }>(
        'SELECT initiative_id FROM initiative WHERE initiative_type_id = ANY($1)',
        [typeIds],
      );
      const ids = events.map((row) => row.initiative_id);
      await testQuery('DELETE FROM volunteer_application WHERE initiative_id = ANY($1)', [ids]);
      await testQuery('DELETE FROM initiative_task WHERE initiative_id = ANY($1)', [ids]);
      await testQuery('DELETE FROM initiative WHERE initiative_id = ANY($1)', [ids]);
      await testQuery('DELETE FROM initiative_type WHERE initiative_type_id = ANY($1)', [typeIds]);
    }
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('never shows drafts to the public', async () => {
    const typeId = await newType();
    const draftId = await newDraft(typeId);

    const list = await publicApi(`/initiatives?typeId=${typeId}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect((await publicApi(`/initiatives/${draftId}`)).status).toBe(404);
    expect((await publicApi(`/initiatives/${draftId}/tasks`)).status).toBe(404);

    // The admin dashboard does see it.
    const adminView = await admin.get(`/initiatives/${draftId}`);
    expect(adminView.body.data).toMatchObject({ status: 'Draft', phase: null });
  });

  it('shows Upcoming and Completed by the date in Johannesburg', async () => {
    const typeId = await newType();
    const endedYesterday = await newDraft(typeId, { startDate: day(-2), endDate: day(-1) });
    const endsToday = await newDraft(typeId, { startDate: day(-1), endDate: day(0) });
    const nextWeek = await newDraft(typeId, { startDate: day(7), endDate: day(7) });
    const closed = await newDraft(typeId, { startDate: day(9), endDate: day(9) });
    for (const id of [endedYesterday, endsToday, nextWeek]) await forceStatus(id, 'Published');
    await forceStatus(closed, 'Closed');

    const all = await publicApi(`/initiatives?typeId=${typeId}`);
    const phases = all.body.data.map((event: { initiativeId: number; phase: string }) => [
      event.initiativeId,
      event.phase,
    ]);
    // Upcoming first (soonest first), then Completed (latest first).
    expect(phases).toEqual([
      [endsToday, 'Upcoming'],
      [nextWeek, 'Upcoming'],
      [closed, 'Completed'],
      [endedYesterday, 'Completed'],
    ]);

    const upcoming = await publicApi(`/initiatives?typeId=${typeId}&phase=upcoming`);
    expect(upcoming.body.meta.total).toBe(2);
    const completed = await publicApi(`/initiatives?typeId=${typeId}&phase=completed`);
    expect(completed.body.meta.total).toBe(2);
  });

  it('publishes only a complete event, which then appears with its tasks', async () => {
    const typeId = await newType();
    const id = await newDraft(typeId, {
      volunteersRequired: true,
      startTime: '10:00',
      endTime: '14:00',
    });

    const notReady = await admin.patch(`/initiatives/${id}/status`, { status: 'Published' });
    expect(notReady.status).toBe(400);
    expect(notReady.body.error.message).toMatch(/isn't ready to publish/);
    expect(notReady.body.error.fields.map((f: { field: string }) => f.field)).toEqual([
      'summary',
      'location',
      'tasks',
    ]);

    await admin.patch(`/initiatives/${id}`, {
      summary: 'Donate clothing or volunteer to sort and prepare bundles.',
      location: 'Orlando Community Hall, Soweto',
    });
    const task = await admin.post(`/initiatives/${id}/tasks`, {
      name: 'Clothing sorting',
      volunteersNeeded: 6,
    });
    expect(task.status).toBe(201);

    const published = await admin.patch(`/initiatives/${id}/status`, { status: 'Published' });
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'Published', phase: 'Upcoming' });

    const page = await publicApi(`/initiatives/${id}`);
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({
      title: 'Community clothing drive',
      location: 'Orlando Community Hall, Soweto',
      timeLabel: '10:00–14:00 SAST',
      phase: 'Upcoming',
      volunteersRequired: true,
      tasks: [{ name: 'Clothing sorting', volunteersNeeded: 6 }],
    });
    expect(page.body.data.status).toBeUndefined(); // admin-only details stay hidden

    const tasks = await publicApi(`/initiatives/${id}/tasks`);
    expect(tasks.body.data).toEqual([
      { taskId: task.body.data.taskId, name: 'Clothing sorting', volunteersNeeded: 6 },
    ]);
  });

  it('gives a friendly error for moving a closed event back to draft', async () => {
    const typeId = await newType();
    const id = await newDraft(typeId);
    await forceStatus(id, 'Closed');

    const res = await admin.patch(`/initiatives/${id}/status`, { status: 'Draft' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      "This event is closed. A closed event can't be moved back to draft.",
    );
  });

  it('checks dates in the form', async () => {
    const typeId = await newType();
    const res = await admin.post('/initiatives', {
      typeId,
      title: 'Backwards event',
      description: 'An event whose end date comes before its start date.',
      startDate: day(5),
      endDate: day(4),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual([
      { field: 'endDate', message: "The end date can't be before the start date." },
    ]);
  });

  it('checks photos: renamed files get 415, files over 2 MB get 413', async () => {
    const typeId = await newType();
    const id = await newDraft(typeId);
    const upload = (buffer: Buffer, filename: string, contentType: string) =>
      request(app)
        .post(`/api/v1/admin/initiatives/${id}/image`)
        .set('Authorization', auth)
        .attach('image', buffer, { filename, contentType });

    const renamed = await upload(
      Buffer.from('This is a text file, not a photo.'),
      'photo.jpg',
      'image/jpeg',
    );
    expect(renamed.status).toBe(415);
    expect(renamed.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    PNG.copy(huge);
    const tooBig = await upload(huge, 'big.png', 'image/png');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const noFile = await admin.post(`/initiatives/${id}/image`);
    expect(noFile.status).toBe(400);

    const first = await upload(PNG, 'event.png', 'image/png');
    expect(first.status).toBe(200);
    const firstUrl: string = first.body.data.imageUrl;
    expect(firstUrl).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/images\/initiatives\//);

    const second = await upload(PNG, 'better.png', 'image/png');
    expect(second.body.data.imageUrl).not.toBe(firstUrl);
    expect(storage.deleted).toContain(firstUrl); // the old photo is removed

    storage.ready = false;
    try {
      expect((await upload(PNG, 'event.png', 'image/png')).status).toBe(503);
    } finally {
      storage.ready = true;
    }
  });

  it('keeps a task that already has volunteer applications', async () => {
    const typeId = await newType();
    const id = await newDraft(typeId);
    const used = await admin.post(`/initiatives/${id}/tasks`, { name: 'Clothing sorting' });
    const unused = await admin.post(`/initiatives/${id}/tasks`, { name: 'Packing bundles' });
    expect(
      (await admin.post(`/initiatives/${id}/tasks`, { name: 'clothing SORTING' })).status,
    ).toBe(409);

    await testQuery(
      `INSERT INTO volunteer_application (initiative_id, initiative_task_id, applicant_name, contact_number,
                                          status, reference_number, consent_given_at)
       VALUES ($1, $2, 'Sipho Dlamini', '+27723456789', 'Submitted', $3, now())`,
      [id, used.body.data.taskId, `VOL-${randomUUID().slice(0, 6).toUpperCase()}`],
    );

    const refused = await admin.delete(`/initiatives/${id}/tasks/${used.body.data.taskId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/already has volunteer applications/);
    expect((await admin.delete(`/initiatives/${id}/tasks/${unused.body.data.taskId}`)).status).toBe(
      200,
    );

    const left = await admin.get(`/initiatives/${id}/tasks`);
    expect(left.body.data).toEqual([
      expect.objectContaining({ name: 'Clothing sorting', applicationCount: 1 }),
    ]);
  });

  it('keeps event type names unique and lists them for everyone', async () => {
    const typeId = await newType();
    const [row] = await testQuery<{ type_name: string }>(
      'SELECT type_name FROM initiative_type WHERE initiative_type_id = $1',
      [typeId],
    );
    const name = row!.type_name;
    const duplicate = await admin.post('/initiative-types', { name: name.toUpperCase() });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.fields[0].field).toBe('name');

    const list = await publicApi('/initiative-types');
    expect(list.body.data).toEqual(expect.arrayContaining([{ typeId, name, description: null }]));
  });

  it('keeps admin event pages closed without sign-in, and records every change', async () => {
    expect((await request(app).get('/api/v1/admin/initiatives')).status).toBe(401);
    const list = await admin.get('/initiatives?status=Draft');
    expect(list.status).toBe(200);
    expect(list.body.data.every((event: { status: string }) => event.status === 'Draft')).toBe(
      true,
    );

    const actions = await testQuery<{ action: string }>(
      'SELECT DISTINCT action FROM audit_log WHERE admin_id = $1',
      [adminId],
    );
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'initiative_type_created',
        'initiative_created',
        'initiative_updated',
        'initiative_published',
        'initiative_image_changed',
        'task_created',
        'task_deleted',
      ]),
    );
  });
});
