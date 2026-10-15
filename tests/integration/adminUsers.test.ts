import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { updateAdmin } from '../../src/modules/adminUsers/adminUsers.service';
import { password } from '../../src/schemas/common';
import { totpCode } from '../../src/utils/totp';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Rate limits have their own tests; here every request comes from one address.
vi.mock('../../src/middleware/rateLimiters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/rateLimiters')>();
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    limiters: {
      global: passThrough,
      login: passThrough,
      codeEntry: passThrough,
      publicForms: passThrough,
      tracking: passThrough,
    },
  };
});

const app = createApp();
const api = '/api/v1/admin';
const users = `${api}/users`;
const PASSWORD = 'Sunrise-Drive-2026';
const createdAdmins: number[] = [];

type TestAdmin = { adminId: number; username: string; auth: string };

/**
 * An admin written straight to the database, with an access token made
 * directly (no sign-in needed). Fresh admins have session version 0.
 */
async function createAdmin(role: 'super_admin' | 'staff'): Promise<TestAdmin> {
  const username = `test.${randomUUID().slice(0, 8)}`;
  const [row] = await testQuery<{ admin_id: number }>(
    `INSERT INTO admin_user (username, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'Test Admin', $4) RETURNING admin_id`,
    [username, `${username}@example.com`, await bcrypt.hash(PASSWORD, 4), role],
  );
  const adminId = row!.admin_id;
  createdAdmins.push(adminId);
  return { adminId, username, auth: `Bearer ${signAccessToken(adminId, 0)}` };
}

const login = (username: string, pass = PASSWORD) =>
  request(app).post(`${api}/auth/login`).send({ username, password: pass });
const me = (accessToken: string) =>
  request(app).get(`${api}/me`).set('Authorization', `Bearer ${accessToken}`);
const refresh = (cookie: string) => request(app).post(`${api}/auth/refresh`).set('Cookie', cookie);
const patchAdmin = (actor: TestAdmin, adminId: number, body: object) =>
  request(app).patch(`${users}/${adminId}`).set('Authorization', actor.auth).send(body);

/** The real first sign-in: password, QR code, first code. */
async function signInFirstTime(username: string, pass = PASSWORD) {
  const first = await login(username, pass);
  expect(first.status).toBe(200);
  const pendingToken: string = first.body.data.pendingToken;
  const setup = await request(app).post(`${api}/auth/2fa/setup`).send({ pendingToken });
  const secret: string = setup.body.data.manualEntryKey.replace(/ /g, '');
  const confirm = await request(app)
    .post(`${api}/auth/2fa/confirm`)
    .send({ pendingToken, code: totpCode(secret) });
  expect(confirm.status).toBe(200);
  const setCookie = ([] as string[]).concat(confirm.headers['set-cookie'] ?? []);
  return {
    session: confirm.body.data,
    accessToken: confirm.body.data.accessToken as string,
    cookie: setCookie.find((c) => c.startsWith('lepara_admin_refresh='))!.split(';')[0]!,
  };
}

async function auditActions(actorId: number, targetId: number): Promise<string[]> {
  const rows = await testQuery<{ action: string }>(
    'SELECT action FROM audit_log WHERE admin_id = $1 AND record_id = $2 ORDER BY audit_id',
    [actorId, String(targetId)],
  );
  return rows.map((row) => row.action);
}

describe.skipIf(!hasTestDatabase)('admin user management', () => {
  let boss: TestAdmin; // the super admin making most of the changes

  beforeAll(async () => {
    boss = await createAdmin('super_admin');
  });

  afterAll(async () => {
    if (createdAdmins.length > 0) {
      await testQuery('DELETE FROM audit_log WHERE admin_id = ANY($1)', [createdAdmins]);
      await testQuery(`DELETE FROM refresh_token WHERE user_type = 'admin' AND user_id = ANY($1)`, [
        createdAdmins,
      ]);
      await testQuery('DELETE FROM admin_backup_code WHERE admin_id = ANY($1)', [createdAdmins]);
      await testQuery('DELETE FROM admin_user WHERE admin_id = ANY($1)', [createdAdmins]);
    }
    await closeTestClient();
    await closePool();
  });

  it('is closed to staff admins (403) and to anyone not signed in (401)', async () => {
    const staff = await createAdmin('staff');
    const list = await request(app).get(users).set('Authorization', staff.auth);
    const create = await request(app)
      .post(users)
      .set('Authorization', staff.auth)
      .send({ username: 'sneaky', fullName: 'Sneaky Person', email: 'sneaky@example.com' });
    for (const res of [list, create]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await request(app).get(users)).status).toBe(401);
  });

  // A full first sign-in makes many trips to the cloud database, so this test gets 2 minutes.
  it(
    'creates an admin with a temporary password; first sign-in sets up 2FA, then a new password',
    { timeout: 120_000 },
    async () => {
      const suffix = randomUUID().slice(0, 6);
      const res = await request(app)
        .post(users)
        .set('Authorization', boss.auth)
        .send({
          username: `New.Staff.${suffix}`,
          fullName: 'Lerato Dlamini',
          email: `Lerato.${suffix}@Example.com`,
        });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { admin, temporaryPassword } = res.body.data;
      createdAdmins.push(admin.adminId);
      expect(admin).toMatchObject({
        username: `new.staff.${suffix}`,
        email: `lerato.${suffix}@example.com`,
        role: 'staff',
        isActive: true,
        twoFactorEnabled: false,
        mustChangePassword: true,
      });
      expect(JSON.stringify(admin)).not.toMatch(/hash|secret/i);
      expect(password.safeParse(temporaryPassword).success).toBe(true);
      expect(await auditActions(boss.adminId, admin.adminId)).toEqual(['admin_created']);

      // First sign-in: authenticator set-up, then the password must be changed.
      const first = await signInFirstTime(admin.username, temporaryPassword);
      expect(first.session.admin.mustChangePassword).toBe(true);
      const blocked = await request(app)
        .get(users)
        .set('Authorization', `Bearer ${first.accessToken}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      const changed = await request(app)
        .patch(`${api}/me/password`)
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({
          currentPassword: temporaryPassword,
          newPassword: 'Lerato-own-2026',
          confirmPassword: 'Lerato-own-2026',
        });
      expect(changed.status).toBe(200);

      // Now fully signed in, but as staff: admin management stays closed.
      const asStaff = await request(app)
        .get(users)
        .set('Authorization', `Bearer ${changed.body.data.accessToken}`);
      expect(asStaff.status).toBe(403);
      expect(asStaff.body.error.code).toBe('FORBIDDEN');
    },
  );

  it('refuses a username or email that another admin already has', async () => {
    const other = await createAdmin('staff');
    const suffix = randomUUID().slice(0, 6);
    const create = (body: object) =>
      request(app).post(users).set('Authorization', boss.auth).send(body);

    const sameUsername = await create({
      username: other.username.toUpperCase(),
      fullName: 'Someone Else',
      email: `someone.${suffix}@example.com`,
    });
    expect(sameUsername.status).toBe(409);
    expect(sameUsername.body.error.fields[0].field).toBe('username');

    const sameEmail = await create({
      username: `someone.${suffix}`,
      fullName: 'Someone Else',
      email: `${other.username}@EXAMPLE.com`,
    });
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.error.fields[0].field).toBe('email');
  });

  it('checks the forms', async () => {
    const bad = await request(app)
      .post(users)
      .set('Authorization', boss.auth)
      .send({ username: 'x', email: 'not-an-email' });
    expect(bad.status).toBe(400);
    const fields = bad.body.error.fields.map((f: { field: string }) => f.field).sort();
    expect(fields).toEqual(['email', 'fullName', 'username']);

    expect((await patchAdmin(boss, boss.adminId, {})).status).toBe(400);
  });

  it('lists, searches and finds admins', async () => {
    const listed = await request(app)
      .get(`${users}?search=${boss.username}`)
      .set('Authorization', boss.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((a: { adminId: number }) => a.adminId)).toEqual([boss.adminId]);
    expect(listed.body.meta).toMatchObject({ page: 1, total: 1 });

    const one = await request(app).get(`${users}/${boss.adminId}`).set('Authorization', boss.auth);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ username: boss.username, role: 'super_admin' });

    const missing = await request(app).get(`${users}/2147483000`).set('Authorization', boss.auth);
    expect(missing.status).toBe(404);
    expect((await request(app).get(`${users}/abc`).set('Authorization', boss.auth)).status).toBe(
      400,
    );
  });

  it('deactivating ends the admin’s sessions at once and stops sign-in; reactivating allows it again', async () => {
    const staff = await createAdmin('staff');
    const { accessToken, cookie } = await signInFirstTime(staff.username);

    const off = await patchAdmin(boss, staff.adminId, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    expect((await me(accessToken)).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await login(staff.username)).status).toBe(401);

    const on = await patchAdmin(boss, staff.adminId, { isActive: true });
    expect(on.status).toBe(200);
    const again = await login(staff.username);
    expect(again.status).toBe(200);
    expect(again.body.data.nextStep).toBe('two_factor_verify');

    expect(await auditActions(boss.adminId, staff.adminId)).toEqual([
      'admin_deactivated',
      'admin_reactivated',
    ]);
  });

  it('changes details and roles, and records each change', async () => {
    const staff = await createAdmin('staff');
    const res = await patchAdmin(boss, staff.adminId, {
      fullName: 'Thabo Mokoena',
      role: 'super_admin',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Thabo Mokoena', role: 'super_admin' });
    const [entry] = await testQuery<{ details: unknown }>(
      `SELECT details FROM audit_log WHERE admin_id = $1 AND record_id = $2`,
      [boss.adminId, String(staff.adminId)],
    );
    expect(entry!.details).toEqual({
      changed: ['fullName', 'role'],
      role: { from: 'staff', to: 'super_admin' },
    });
  });

  it('lets nobody deactivate themselves or change their own role', async () => {
    const deactivate = await patchAdmin(boss, boss.adminId, { isActive: false });
    expect(deactivate.status).toBe(400);
    expect(deactivate.body.error.message).toMatch(/your own account/);

    const demote = await patchAdmin(boss, boss.adminId, { role: 'staff' });
    expect(demote.status).toBe(400);
    expect(demote.body.error.message).toMatch(/your own role/);

    // Changing your own name is fine.
    expect((await patchAdmin(boss, boss.adminId, { fullName: 'Boss Admin' })).status).toBe(200);
  });

  it('always keeps at least one active super admin', async () => {
    // For this test, the two super admins made here must be the only active ones.
    const paused = await testQuery<{ admin_id: number }>(
      `UPDATE admin_user SET is_active = false
       WHERE role = 'super_admin' AND is_active RETURNING admin_id`,
    );
    try {
      const a = await createAdmin('super_admin');
      const b = await createAdmin('super_admin');

      // A and B try to deactivate each other at the same moment: only one can win.
      const results = await Promise.all([
        patchAdmin(a, b.adminId, { isActive: false }),
        patchAdmin(b, a.adminId, { isActive: false }),
      ]);
      const statuses = results.map((res) => res.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      const [count] = await testQuery<{ active: number }>(
        `SELECT count(*)::int AS active FROM admin_user WHERE role = 'super_admin' AND is_active`,
      );
      expect(count!.active).toBe(1);

      // The one left can't be deactivated or demoted, whoever asks.
      const last = statuses[0] === 200 ? a : b;
      const staff = await createAdmin('staff');
      await expect(
        updateAdmin(staff.adminId, last.adminId, { isActive: false }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        updateAdmin(staff.adminId, last.adminId, { role: 'staff' }),
      ).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await testQuery('UPDATE admin_user SET is_active = true WHERE admin_id = ANY($1)', [
        paused.map((row) => row.admin_id),
      ]);
    }
  });

  it('resets two-factor sign-in for a lost phone', async () => {
    const staff = await createAdmin('staff');
    const { accessToken } = await signInFirstTime(staff.username);

    const res = await request(app)
      .post(`${users}/${staff.adminId}/reset-2fa`)
      .set('Authorization', boss.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.twoFactorEnabled).toBe(false);

    expect((await me(accessToken)).status).toBe(401);
    const codes = await testQuery('SELECT 1 FROM admin_backup_code WHERE admin_id = $1', [
      staff.adminId,
    ]);
    expect(codes).toHaveLength(0);
    expect((await login(staff.username)).body.data.nextStep).toBe('two_factor_setup');
    expect(await auditActions(boss.adminId, staff.adminId)).toEqual(['two_factor_reset']);
  });

  it('gives a new temporary password for a forgotten one', async () => {
    const staff = await createAdmin('staff');
    const res = await request(app)
      .post(`${users}/${staff.adminId}/reset-password`)
      .set('Authorization', boss.auth);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.admin.mustChangePassword).toBe(true);
    const temporaryPassword: string = res.body.data.temporaryPassword;
    expect(password.safeParse(temporaryPassword).success).toBe(true);

    expect((await login(staff.username)).status).toBe(401); // the old password no longer works
    expect((await login(staff.username, temporaryPassword)).status).toBe(200);
    expect(await auditActions(boss.adminId, staff.adminId)).toEqual(['password_reset']);

    // Your own password is changed under /admin/me/password instead.
    const own = await request(app)
      .post(`${users}/${boss.adminId}/reset-password`)
      .set('Authorization', boss.auth);
    expect(own.status).toBe(400);
  });
});
