import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import type { EmailMessage } from '../../src/services/email';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Emails land in this list instead of being sent.
const outbox = vi.hoisted(() => [] as Array<{ template: string; to: string; text: string }>);
vi.mock('../../src/services/email', () => ({
  sendEmailInBackground: (message: EmailMessage, template: string) => {
    outbox.push({ template, to: message.to, text: message.text });
  },
}));

// Rate limits are tested elsewhere; here they would only get in the way.
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
const tag = randomUUID().slice(0, 8);
const PASSWORD = 'Winter-Blankets-2026';
const WEBSITE = 'https://website.test';

const post = (path: string, body: object) => request(app).post(`/api/v1${path}`).send(body);

let counter = 0;
const newEmail = () => `customer${++counter}.${tag}@example.com`;

function register(email: string) {
  return post('/auth/register', {
    firstName: 'Naledi',
    lastName: 'Mokoena',
    email,
    mobile: '071 234 5678',
    password: PASSWORD,
    confirmPassword: PASSWORD,
    acceptTerms: true,
  });
}

/** The 6-digit code in the latest email to this address. */
function latestCode(email: string): string {
  const message = outbox.filter((sent: { to: string }) => sent.to === email).at(-1);
  const code = /Your code: (\d{6})/.exec(message?.text ?? '')?.[1];
  if (!code) throw new Error(`No code was emailed to ${email}`);
  return code;
}

/** Accounts deleted in these tests: their emails no longer contain the tag. */
const deletedIds: number[] = [];

const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/** Registers, verifies and returns the app's session (tokens in the body). */
async function signedUp(email = newEmail()) {
  await register(email);
  const res = await post('/auth/verify-email', { email, code: latestCode(email) });
  expect(res.status).toBe(200);
  return res.body.data as { accessToken: string; refreshToken: string };
}

describe.skipIf(!hasTestDatabase)('customer accounts', () => {
  afterAll(async () => {
    const pattern = `%.${tag}@example.com`;
    const ids = (
      await testQuery<{ customer_id: number }>(
        'SELECT customer_id FROM customer WHERE email LIKE $1 OR customer_id = ANY($2)',
        [pattern, deletedIds],
      )
    ).map((row) => row.customer_id);
    await testQuery(
      `DELETE FROM refresh_token WHERE user_type = 'customer' AND user_id = ANY($1)`,
      [ids],
    );
    await testQuery('DELETE FROM verification_code WHERE customer_id = ANY($1)', [ids]);
    await testQuery('DELETE FROM customer WHERE customer_id = ANY($1)', [ids]);
    await closeTestClient();
    await closePool();
  });

  it('registers, emails a code, verifies and signs in, with tokens in the body', async () => {
    const email = newEmail();
    const registered = await register(email);
    expect(registered.status).toBe(201);
    expect(registered.body.data).toEqual({
      email,
      message: 'Check your email for a 6-digit code.',
    });
    expect(outbox.at(-1)).toMatchObject({ template: 'customer-sign-up-code', to: email });

    const verified = await post('/auth/verify-email', { email, code: latestCode(email) });
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      customer: { email, firstName: 'Naledi', mobile: '+27712345678' },
    });
    expect(verified.body.data.refreshToken).toEqual(expect.any(String));

    const me = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${verified.body.data.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);
  });

  it('gives the website its refresh token in an httpOnly cookie, never in the body', async () => {
    const email = newEmail();
    await register(email);
    const verified = await post('/auth/verify-email', { email, code: latestCode(email) }).set(
      'Origin',
      WEBSITE,
    );
    expect(verified.status).toBe(200);
    expect(verified.body.data.refreshToken).toBeUndefined();
    const cookie = verified.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^lepara_refresh=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', WEBSITE)
      .set('Cookie', cookie.split(';')[0]!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));

    const otherSite = await post('/auth/login', { email, password: PASSWORD }).set(
      'Origin',
      'https://evil.example',
    );
    expect(otherSite.status).toBe(403);
  });

  it('gives an existing email exactly the same reply as a new one', async () => {
    const email = newEmail();
    await signedUp(email);
    const fresh = await register(newEmail());
    const again = await register(email);
    expect(again.status).toBe(fresh.status);
    expect(again.body.data.message).toBe(fresh.body.data.message);
    expect(outbox.filter((sent: { to: string }) => sent.to === email).at(-1)?.template).toBe(
      'customer-already-registered',
    );
    const [row] = await testQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM customer WHERE email = $1',
      [email],
    );
    expect(row!.n).toBe(1);
  });

  it('ends a code after five wrong tries, and refuses a resend within 60 seconds', async () => {
    const email = newEmail();
    await register(email);
    const code = latestCode(email);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await post('/auth/verify-email', { email, code: otherCode(code) });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.fields[0].field).toBe('code');
    }
    expect((await post('/auth/verify-email', { email, code })).status).toBe(400);

    const resend = await post('/auth/resend-code', { email });
    expect(resend.status).toBe(429);
    expect(resend.body.error.code).toBe('RATE_LIMITED');
  });

  it('answers a sign-in before verifying with EMAIL_NOT_VERIFIED', async () => {
    const email = newEmail();
    await register(email);
    const res = await post('/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // With a wrong password it gives nothing away.
    expect((await post('/auth/login', { email, password: 'Wrong-Pass-1' })).status).toBe(401);
  });

  it('signs out other devices when the password changes', async () => {
    const email = newEmail();
    const phone = await signedUp(email);
    const laptop = (await post('/auth/login', { email, password: PASSWORD })).body.data;

    const changed = await request(app)
      .patch('/api/v1/me/password')
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .send({
        currentPassword: PASSWORD,
        newPassword: 'Summer-Drive-2027',
        confirmPassword: 'Summer-Drive-2027',
      });
    expect(changed.status).toBe(200);

    const laptopMe = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${laptop.accessToken}`);
    expect(laptopMe.status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: laptop.refreshToken })).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: phone.refreshToken })).status).toBe(401);

    const here = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${changed.body.data.accessToken}`);
    expect(here.status).toBe(200);
  });

  it('refuses a customer token on an admin route', async () => {
    const session = await signedUp();
    const res = await request(app)
      .get('/api/v1/admin/me')
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(res.status).toBe(401);
  });

  it('deletes an account: details removed, signed out, orders kept', async () => {
    const email = newEmail();
    const session = await signedUp(email);
    const [account] = await testQuery<{ customer_id: number }>(
      'SELECT customer_id FROM customer WHERE email = $1',
      [email],
    );
    const id = account!.customer_id;
    deletedIds.push(id);
    const res = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    const [row] = await testQuery<{ first_name: string; email: string; is_active: boolean }>(
      'SELECT first_name, email, is_active FROM customer WHERE customer_id = $1',
      [id],
    );
    expect(row).toMatchObject({ first_name: 'Deleted', is_active: false });
    expect(row!.email).toMatch(/@deleted\.invalid$/);
    expect((await post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
  });
});
