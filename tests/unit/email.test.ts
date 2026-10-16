import { describe, expect, it } from 'vitest';
import {
  BREVO_URL,
  EMAIL_ATTEMPTS,
  type MailSender,
  brevoSender,
  deliver,
  isPermanentMailError,
  maskEmail,
  parseAddress,
  sendEmail,
} from '../../src/services/email';
import {
  assistanceRequestDeclined,
  donationPledgeReceived,
  enquiryReceived,
  escapeHtml,
  volunteerApplicationAccepted,
  volunteerApplicationReceived,
} from '../../src/services/emailTemplates';

const message = { to: 'sipho@example.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' };
const outgoing = { ...message, from: 'Lepara Ale fele Moya <hello@example.org>' };

/** A pretend mail server that fails with the given errors, then accepts. */
function fakeSender(failures: unknown[]): MailSender & { calls: number } {
  const sender = {
    calls: 0,
    async sendMail() {
      const failure = failures[sender.calls];
      sender.calls += 1;
      if (failure) throw failure;
      return { messageId: '<1@test>' };
    },
  };
  return sender;
}

const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' });
const noDelay = { template: 'test', retryDelaysMs: [0, 0] };

describe('sending email', () => {
  it('tries again when the mail server is unreachable', async () => {
    const sender = fakeSender([unreachable, unreachable]);
    await expect(deliver(sender, outgoing, noDelay)).resolves.toEqual({ messageId: '<1@test>' });
    expect(sender.calls).toBe(3);
  });

  it(`gives up after ${EMAIL_ATTEMPTS} tries`, async () => {
    const sender = fakeSender([unreachable, unreachable, unreachable, unreachable]);
    await expect(deliver(sender, outgoing, noDelay)).rejects.toThrow('ECONNREFUSED');
    expect(sender.calls).toBe(EMAIL_ATTEMPTS);
  });

  it("doesn't retry errors that won't fix themselves", async () => {
    const wrongPassword = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    const sender = fakeSender([wrongPassword]);
    await expect(deliver(sender, outgoing, noDelay)).rejects.toThrow('Invalid login');
    expect(sender.calls).toBe(1);

    expect(isPermanentMailError({ responseCode: 550 })).toBe(true);
    expect(isPermanentMailError({ responseCode: 421 })).toBe(false);
    expect(isPermanentMailError(unreachable)).toBe(false);
  });

  it('never sends real email during tests', async () => {
    await expect(sendEmail(message, 'test')).resolves.toBe('skipped');
  });

  it("sends through Brevo's web API with the sender split into name and address", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messageId: '<1@brevo>' }), { status: 201 });
    }) as unknown as typeof fetch;

    await expect(brevoSender('xkeysib-test', fakeFetch).sendMail(outgoing)).resolves.toEqual({
      messageId: '<1@brevo>',
    });
    expect(calls[0]!.url).toBe(BREVO_URL);
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sender: { name: 'Lepara Ale fele Moya', email: 'hello@example.org' },
      to: [{ email: 'sipho@example.com' }],
      subject: 'Hello',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
    });
    expect(parseAddress('hello@example.org')).toEqual({ email: 'hello@example.org' });
  });

  it("retries Brevo when it's busy, but not when the key is wrong", async () => {
    const replying = (status: number) =>
      (async () =>
        new Response(JSON.stringify({ message: 'Key not found' }), {
          status,
        })) as unknown as typeof fetch;

    const wrongKey = brevoSender('wrong', replying(401));
    await expect(wrongKey.sendMail(outgoing)).rejects.toThrow('Brevo replied 401: Key not found');
    expect(isPermanentMailError(await wrongKey.sendMail(outgoing).catch((e) => e))).toBe(true);

    const busy = brevoSender('xkeysib-test', replying(503));
    expect(isPermanentMailError(await busy.sendMail(outgoing).catch((e) => e))).toBe(false);
  });

  it('hides most of an address in the logs', () => {
    expect(maskEmail('naledi.mokoena@example.com')).toBe('na***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-address')).toBe('***');
  });
});

describe('email templates', () => {
  const volunteer = {
    to: 'sipho@example.com',
    name: 'Sipho Dlamini',
    referenceNumber: 'VOL-7K3P9X',
    eventTitle: 'Community clothing drive',
    eventDate: '24 Oct 2026',
    eventTime: '10:00–14:00 SAST',
    location: 'Orlando Community Hall, Soweto',
    taskName: 'Clothing sorting',
  };

  it('puts the reference number in the subject, the text and the HTML', () => {
    const email = volunteerApplicationReceived(volunteer);
    expect(email.to).toBe('sipho@example.com');
    expect(email.subject).toBe('Volunteer application received: VOL-7K3P9X');
    expect(email.text).toContain('Your reference number: VOL-7K3P9X');
    expect(email.text).toContain('Task: Clothing sorting');
    expect(email.text).toContain('Hi Sipho Dlamini,');
    expect(email.html).toContain('VOL-7K3P9X');
  });

  it('escapes names and titles in the HTML', () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;',
    );
    const email = volunteerApplicationReceived({
      ...volunteer,
      eventTitle: '<script>alert(1)</script> drive',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('leaves out rows that have no value', () => {
    const email = donationPledgeReceived({
      to: 'naledi@example.com',
      name: 'Naledi',
      referenceNumber: 'PLG-AB23CD',
      category: 'Goods',
      eventTitle: null,
    });
    expect(email.text).toContain('Donation type: Goods');
    expect(email.text).not.toContain('For:');
    expect(email.text).toContain('No payment is collected');
  });

  it('thanks enquirers without a reference number', () => {
    const email = enquiryReceived({ to: 'a@example.org', name: 'Ayanda', enquiryType: 'Partner' });
    expect(email.subject).toBe('We have received your enquiry');
    expect(email.text).toContain('partnering with us');
    expect(email.text).not.toMatch(/reference number/i);
  });

  it('tells people the decision, with the reason when declined', () => {
    const accepted = volunteerApplicationAccepted({
      to: 'sipho@example.com',
      name: 'Sipho Dlamini',
      referenceNumber: 'VOL-7K3P9X',
      eventTitle: 'Community clothing drive',
      eventDate: '24 Oct 2026',
      eventTime: '10:00–14:00 SAST',
      location: null,
      taskName: 'Clothing sorting',
    });
    expect(accepted.subject).toBe('Volunteer application accepted: VOL-7K3P9X');
    expect(accepted.text).toContain('Task: Clothing sorting');
    expect(accepted.text).not.toContain('Place:');

    const declined = assistanceRequestDeclined({
      to: 'thandi@example.com',
      name: 'Thandi',
      referenceNumber: 'REQ-AB23CD',
      requestType: 'Blankets',
      reason: 'No <blankets> left\nthis month.',
    });
    expect(declined.subject).toBe('Update on your request: REQ-AB23CD');
    expect(declined.text).toContain('Reason: No <blankets> left this month.');
    expect(declined.html).toContain('No &lt;blankets&gt; left this month.');
  });
});
