import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { hashRefreshToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { totpCode, totpStep } from '../../src/utils/totp';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Rate limits have their own tests (requestHandling.test.ts). Here they would
// only get in the way, because every test signs in from the same address.
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
const PASSWORD = 'Sunrise-Drive-2026';
const NEW_PASSWORD = 'Brand-new-2026';
const createdAdmins: number[] = [];

/** A fresh admin for each test, so tests never affect each other. */
async function createAdmin(): Promise<{ adminId: number; username: string }> {
  const username = `test.${randomUUID().slice(0, 8)}`;
  const [row] = await testQuery<{ admin_id: number }>(
    `INSERT INTO admin_user (username, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'Test Admin', 'super_admin') RETURNING admin_id`,
    // Cost 4 keeps the tests quick; the API itself uses 12.
    [username, `${username}@example.com`, await bcrypt.hash(PASSWORD, 4)],
  );
  createdAdmins.push(row!.admin_id);
  return { adminId: row!.admin_id, username };
}

const api = '/api/v1/admin';
const login = (username: string, password = PASSWORD) =>
  request(app).post(`${api}/auth/login`).send({ username, password });
const verify = (pendingToken: string, code: string) =>
  request(app).post(`${api}/auth/2fa/verify`).send({ pendingToken, code });
const refresh = (cookie: string) => request(app).post(`${api}/auth/refresh`).set('Cookie', cookie);
const me = (accessToken: string) =>
  request(app).get(`${api}/me`).set('Authorization', `Bearer ${accessToken}`);

/** The full Set-Cookie line for the refresh cookie. */
function refreshCookieLine(res: request.Response): string {
  const header = res.headers['set-cookie'] as string | string[] | undefined;
  const line = ([] as string[])
    .concat(header ?? [])
    .find((cookie) => cookie.startsWith('lepara_admin_refresh='));
  if (!line) throw new Error('The reply did not set the refresh cookie.');
  return line;
}

/** "lepara_admin_refresh=<token>", ready to send back in a Cookie header. */
const cookieFrom = (res: request.Response) => refreshCookieLine(res).split(';')[0]!;

/** A 6-digit code that is definitely wrong right now. */
function wrongCodeFor(secret: string): string {
  const step = totpStep();
  const valid = new Set([step - 1, step, step + 1].map((s) => totpCode(secret, s)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

/** First sign-in for a new admin: password, QR code, first code. */
async function setUpTwoFactor(username: string) {
  const first = await login(username);
  const pendingToken: string = first.body.data.pendingToken;
  const setup = await request(app).post(`${api}/auth/2fa/setup`).send({ pendingToken });
  const secret: string = setup.body.data.manualEntryKey.replace(/ /g, '');
  const confirm = await request(app)
    .post(`${api}/auth/2fa/confirm`)
    .send({ pendingToken, code: totpCode(secret) });
  expect(confirm.status).toBe(200);
  return {
    secret,
    confirm,
    accessToken: confirm.body.data.accessToken as string,
    cookie: cookieFrom(confirm),
  };
}

/** Each app code works once; this lets a test use the current code again. */
async function allowCodeReuse(adminId: number): Promise<void> {
  await testQuery('UPDATE admin_user SET totp_last_used_step = NULL WHERE admin_id = $1', [
    adminId,
  ]);
}

describe.skipIf(!hasTestDatabase)('admin sign-in', () => {
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

  it('gives the same answer for a wrong password and an unknown username', async () => {
    const { username } = await createAdmin();
    const wrongPassword = await login(username, 'Not-the-password-1');
    const unknownUser = await login('nobody.by.this.name');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe('Your username or password is incorrect.');
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('checks the form first, one message per field', async () => {
    const res = await request(app).post(`${api}/auth/login`).send({ username: ' ' });
    expect(res.status).toBe(400);
    const fields = res.body.error.fields.map((f: { field: string }) => f.field).sort();
    expect(fields).toEqual(['password', 'username']);
  });

  it('takes a new admin through authenticator set-up to a signed-in session', async () => {
    const { adminId, username } = await createAdmin();

    const first = await login(username.toUpperCase()); // capitals in usernames don't matter
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ nextStep: 'two_factor_setup', expiresIn: 600 });
    const pendingToken = first.body.data.pendingToken;

    // A password alone never opens admin pages.
    expect((await me(pendingToken)).status).toBe(401);

    const setup = await request(app).post(`${api}/auth/2fa/setup`).send({ pendingToken });
    expect(setup.status).toBe(200);
    expect(setup.body.data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.data.otpauthUrl).toContain(`:${username}?secret=`);
    const secret = setup.body.data.manualEntryKey.replace(/ /g, '');

    const wrong = await request(app)
      .post(`${api}/auth/2fa/confirm`)
      .send({ pendingToken, code: wrongCodeFor(secret) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields[0]).toMatchObject({ field: 'code' });

    const confirm = await request(app)
      .post(`${api}/auth/2fa/confirm`)
      .send({ pendingToken, code: totpCode(secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.headers['cache-control']).toBe('no-store');
    expect(confirm.body.data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      admin: { adminId, username, twoFactorEnabled: true, backupCodesRemaining: 10 },
    });
    expect(confirm.body.data.refreshToken).toBeUndefined(); // only in the cookie
    const backupCodes: string[] = confirm.body.data.backupCodes;
    expect(new Set(backupCodes).size).toBe(10);

    const cookie = refreshCookieLine(confirm);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/admin\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // The database holds only an encrypted secret and hashed codes.
    const [stored] = await testQuery<{ totp_secret_encrypted: string }>(
      'SELECT totp_secret_encrypted FROM admin_user WHERE admin_id = $1',
      [adminId],
    );
    expect(stored!.totp_secret_encrypted).not.toContain(secret);
    const hashes = await testQuery<{ code_hash: string }>(
      'SELECT code_hash FROM admin_backup_code WHERE admin_id = $1',
      [adminId],
    );
    expect(hashes).toHaveLength(10);
    for (const code of backupCodes) {
      expect(hashes.some((row) => row.code_hash.includes(code.replace('-', '')))).toBe(false);
    }

    const profile = await me(confirm.body.data.accessToken);
    expect(profile.status).toBe(200);
    expect(profile.body.data).toMatchObject({ adminId, username, role: 'super_admin' });
  });

  it('asks for the app code at later sign-ins, and each code works only once', async () => {
    const { adminId, username } = await createAdmin();
    const { secret } = await setUpTwoFactor(username);
    await allowCodeReuse(adminId);

    const first = await login(username);
    expect(first.body.data).toMatchObject({ nextStep: 'two_factor_verify', expiresIn: 300 });
    const code = totpCode(secret);
    expect((await verify(first.body.data.pendingToken, code)).status).toBe(200);

    const second = await login(username);
    const replayed = await verify(second.body.data.pendingToken, code);
    expect(replayed.status).toBe(400);
    expect(replayed.body.error.message).toMatch(/already been used/);

    const wrong = await verify(second.body.data.pendingToken, wrongCodeFor(secret));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/incorrect/);
  });

  it('accepts each backup code once', async () => {
    const { username } = await createAdmin();
    const { confirm } = await setUpTwoFactor(username);
    const backupCode: string = confirm.body.data.backupCodes[0];

    const first = await login(username);
    const used = await verify(first.body.data.pendingToken, backupCode.toLowerCase());
    expect(used.status).toBe(200);
    expect(used.body.data.admin.backupCodesRemaining).toBe(9);

    const second = await login(username);
    const reused = await verify(second.body.data.pendingToken, backupCode);
    expect(reused.status).toBe(400);
    expect(reused.body.error.message).toMatch(/incorrect or has already been used/);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const { adminId, username } = await createAdmin();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await login(username, 'Wrong-password-1')).status).toBe(401);
    }
    const fifth = await login(username, 'Wrong-password-1');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(fifth.body.error.message).toMatch(/try again in 15 minutes/);

    // While locked, even the right password is refused.
    expect((await login(username)).status).toBe(423);

    const audit = await testQuery(
      `SELECT 1 FROM audit_log WHERE admin_id = $1 AND action = 'account_locked'`,
      [adminId],
    );
    expect(audit).toHaveLength(1);
  });

  it('counts wrong authenticator codes towards the lock as well', async () => {
    const { adminId, username } = await createAdmin();
    const { secret } = await setUpTwoFactor(username);
    await allowCodeReuse(adminId);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await login(username, 'Wrong-password-1')).status).toBe(401);
    }
    const passwordOk = await login(username);
    const wrongCode = await verify(passwordOk.body.data.pendingToken, wrongCodeFor(secret));
    expect(wrongCode.status).toBe(423);
  });

  it('swaps the refresh cookie for a new access token; a copied old cookie signs out everywhere', async () => {
    const { username } = await createAdmin();
    const { cookie: firstCookie } = await setUpTwoFactor(username);

    const refreshed = await refresh(firstCookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    const secondCookie = cookieFrom(refreshed);
    expect(secondCookie).not.toBe(firstCookie);
    expect((await me(refreshed.body.data.accessToken)).status).toBe(200);

    // Someone copied the first cookie and uses it a minute later.
    await testQuery(
      `UPDATE refresh_token SET revoked_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [hashRefreshToken(firstCookie.split('=')[1]!)],
    );
    const stolen = await refresh(firstCookie);
    expect(stolen.status).toBe(401);
    expect(stolen.body.error.message).toMatch(/signed out on all devices/);

    // The real session ended too: its cookie and its access token no longer work.
    expect((await refresh(secondCookie)).status).toBe(401);
    expect((await me(refreshed.body.data.accessToken)).status).toBe(401);
  });

  it('lets two browser tabs refresh at the same moment', async () => {
    const { username } = await createAdmin();
    const { cookie } = await setUpTwoFactor(username);
    expect((await refresh(cookie)).status).toBe(200);
    expect((await refresh(cookie)).status).toBe(200); // within the 10-second grace period
  });

  it('signs out, clearing the cookie and ending the session', async () => {
    const { username } = await createAdmin();
    const { cookie } = await setUpTwoFactor(username);
    const out = await request(app).post(`${api}/auth/logout`).set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(refreshCookieLine(out)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await refresh(cookie)).status).toBe(401);
  });

  it('signs out everywhere on request', async () => {
    const { username } = await createAdmin();
    const { cookie, accessToken } = await setUpTwoFactor(username);
    const out = await request(app)
      .post(`${api}/auth/logout-all`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(out.status).toBe(200);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await me(accessToken)).status).toBe(401);
  });

  it('keeps admin pages closed without a valid access token', async () => {
    expect((await request(app).get(`${api}/me`)).status).toBe(401);
    expect((await me('not.a.token')).status).toBe(401);
    // Admin addresses that don't exist yet say 401 too, so they reveal nothing.
    const unknown = await request(app).get(`${api}/initiatives`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('UNAUTHORIZED');
  });

  it('changes the password, ending other sessions but keeping this one', async () => {
    const { username } = await createAdmin();
    const { accessToken: oldAccess, cookie: oldCookie } = await setUpTwoFactor(username);
    const change = (currentPassword: string) =>
      request(app)
        .patch(`${api}/me/password`)
        .set('Authorization', `Bearer ${oldAccess}`)
        .send({ currentPassword, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    const wrong = await change('Not-my-password-1');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields).toEqual([
      { field: 'currentPassword', message: 'Your current password is incorrect.' },
    ]);

    const changed = await change(PASSWORD);
    expect(changed.status).toBe(200);
    expect((await me(changed.body.data.accessToken)).status).toBe(200);
    expect((await me(oldAccess)).status).toBe(401);
    expect((await refresh(oldCookie)).status).toBe(401);

    expect((await login(username)).status).toBe(401);
    expect((await login(username, NEW_PASSWORD)).status).toBe(200);
  });

  it('allows nothing but a password change while a temporary password is in use', async () => {
    const { adminId, username } = await createAdmin();
    const { accessToken } = await setUpTwoFactor(username);
    await testQuery('UPDATE admin_user SET must_change_password = true WHERE admin_id = $1', [
      adminId,
    ]);

    const profile = await me(accessToken);
    expect(profile.status).toBe(200);
    expect(profile.body.data.mustChangePassword).toBe(true);

    const blocked = await request(app)
      .get(`${api}/initiatives`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await request(app)
      .patch(`${api}/me/password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
    expect(changed.status).toBe(200);
    expect(changed.body.data.admin.mustChangePassword).toBe(false);

    // Now the address is open (and answers 404 until a later step builds it).
    const open = await request(app)
      .get(`${api}/initiatives`)
      .set('Authorization', `Bearer ${changed.body.data.accessToken}`);
    expect(open.status).toBe(404);
  });

  it('refuses sign-in requests from other websites', async () => {
    const evil = await request(app)
      .post(`${api}/auth/refresh`)
      .set('Origin', 'https://evil.example');
    expect(evil.status).toBe(403);
    const website = await request(app)
      .post(`${api}/auth/logout`)
      .set('Origin', 'https://website.test');
    expect(website.status).toBe(200);
  });

  it('refuses a deactivated admin', async () => {
    const { adminId, username } = await createAdmin();
    await testQuery('UPDATE admin_user SET is_active = false WHERE admin_id = $1', [adminId]);
    expect((await login(username)).status).toBe(401);
  });
});
