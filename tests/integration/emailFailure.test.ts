import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import {
  type MailSender,
  setMailSenderForTests,
  waitForPendingEmails,
} from '../../src/services/email';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

/**
 * The plan's failure handling: a mail service that refuses every email (a wrong
 * API key, say) must never break a form. The person still gets their reference
 * number, the request is saved, and the API keeps answering.
 */

const app = createApp();
const email = `mailfail.${randomUUID().slice(0, 8)}@example.com`;

describe.skipIf(!hasTestDatabase)('when the mail service fails', () => {
  afterAll(async () => {
    setMailSenderForTests(null);
    await testQuery('DELETE FROM assistance_request WHERE email = $1', [email]);
    await closeTestClient();
    await closePool();
  });

  it('a form still succeeds, is saved and keeps its reference number', async () => {
    let attempts = 0;
    const refusing: MailSender = {
      async sendMail() {
        attempts += 1;
        throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
      },
    };
    setMailSenderForTests(refusing);

    const res = await request(app).post('/api/v1/assistance-requests').send({
      fullName: 'Naledi Mokoena',
      phone: '071 234 5678',
      email,
      requestType: 'Blankets',
      description: 'We are a family of five and need warm blankets for winter.',
      consent: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.referenceNumber).toMatch(/^REQ-/);

    await waitForPendingEmails();
    expect(attempts).toBeGreaterThan(0); // the email was tried, and failed

    const [saved] = await testQuery<{ status: string }>(
      'SELECT status FROM assistance_request WHERE reference_number = $1',
      [res.body.data.referenceNumber],
    );
    expect(saved).toEqual({ status: 'Submitted' });
    expect((await request(app).get('/api/v1/form-options')).status).toBe(200);
  });
});
