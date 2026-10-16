import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { announcementPublished } from '../../src/services/notifications';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Push notifications arrive in step 17; here we only check they are asked for.
vi.mock('../../src/services/notifications', () => ({
  announcementPublished: vi.fn(async () => undefined),
}));

const app = createApp();
let adminId = 0;
let auth = '';
const created: number[] = [];

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', auth),
  post: (path: string, body: object) =>
    request(app).post(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
};

async function publish(title: string): Promise<number> {
  const res = await admin.post('/announcements', {
    title,
    body: 'Details for the community, written by the team.',
  });
  expect(res.status).toBe(201);
  created.push(res.body.data.announcementId);
  return res.body.data.announcementId;
}

/** The IDs on the public News list, in order, keeping only this file's announcements. */
async function publicIds(): Promise<number[]> {
  const res = await request(app).get('/api/v1/announcements?pageSize=50');
  expect(res.status).toBe(200);
  return res.body.data
    .map((item: { announcementId: number }) => item.announcementId)
    .filter((id: number) => created.includes(id));
}

describe.skipIf(!hasTestDatabase)('announcements', () => {
  beforeAll(async () => {
    const username = `test.${randomUUID().slice(0, 8)}`;
    const [row] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'News Admin', 'staff') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = row!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`;
  });

  afterAll(async () => {
    await testQuery('DELETE FROM announcement WHERE published_by = $1', [adminId]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('publishes straight away, newest first, and asks for a notification', async () => {
    const first = await publish('Winter drive dates');
    const second = await publish('Thank you, volunteers');

    expect(await publicIds()).toEqual([second, first]);
    expect(announcementPublished).toHaveBeenCalledWith({
      announcementId: second,
      title: 'Thank you, volunteers',
    });

    const item = await admin.get(`/announcements/${second}`);
    expect(item.body.data).toMatchObject({
      title: 'Thank you, volunteers',
      isActive: true,
      publishedBy: { adminId, fullName: 'News Admin' },
    });
    expect(item.body.data.dateLabel).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  });

  it('never shows hidden announcements publicly, and can show them again', async () => {
    const id = await publish('Venue change for Saturday');

    const hidden = await admin.patch(`/announcements/${id}/active`, { isActive: false });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.isActive).toBe(false);
    expect(await publicIds()).not.toContain(id);

    const shown = await admin.patch(`/announcements/${id}/active`, { isActive: true });
    expect(shown.body.data.isActive).toBe(true);
    expect(await publicIds()).toContain(id);
  });

  it('pages the public list', async () => {
    await publish('Page test one');
    await publish('Page test two');
    const res = await request(app).get('/api/v1/announcements?page=1&pageSize=2');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2 });
    expect(res.body.meta.totalPages).toBe(Math.ceil(res.body.meta.total / 2));
    // Only public fields: no status or author on the News screen.
    expect(res.body.data[0].isActive).toBeUndefined();
    expect(res.body.data[0].publishedBy).toBeUndefined();
  });

  it('edits without changing the publishing date', async () => {
    const id = await publish('Clothing drive update');
    const before = await admin.get(`/announcements/${id}`);
    const edited = await admin.patch(`/announcements/${id}`, { title: 'Clothing drive: new time' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.title).toBe('Clothing drive: new time');
    expect(edited.body.data.publishedAt).toBe(before.body.data.publishedAt);
  });

  it('checks the form and unknown announcements', async () => {
    const bad = await admin.post('/announcements', { title: 'Hi', body: 'Short' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.map((f: { field: string }) => f.field)).toEqual(['title', 'body']);
    expect((await admin.get('/announcements/2147483000')).status).toBe(404);
    expect((await request(app).get('/api/v1/admin/announcements')).status).toBe(401);
  });

  it('keeps the announcement even if the notification fails', async () => {
    vi.mocked(announcementPublished).mockRejectedValueOnce(new Error('push service down'));
    await publish('Notification failure test');
  });

  it('records every change in the audit log', async () => {
    const rows = await testQuery<{ action: string }>(
      'SELECT DISTINCT action FROM audit_log WHERE admin_id = $1 ORDER BY action',
      [adminId],
    );
    expect(rows.map((row) => row.action)).toEqual([
      'announcement_hidden',
      'announcement_published',
      'announcement_shown',
      'announcement_updated',
    ]);
  });
});
