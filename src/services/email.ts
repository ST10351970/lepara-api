import { createTestAccount, createTransport, getTestMessageUrl } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Sends emails such as "Your reference number is VOL-7K3P9X".
 *
 * Where emails go, in this order:
 *  - BREVO_API_KEY is set: through Brevo's web API (HTTPS). Use this on Render's
 *    free plan, which blocks the usual email (SMTP) ports.
 *  - SMTP_HOST is set: through that SMTP service (Brevo, Gmail, ...).
 *  - Development with neither: a free test inbox at ethereal.email. Nothing
 *    reaches a real person; the log shows a link to read each email.
 *  - Tests, or the live API with neither: nothing is sent, and the log says so.
 *
 * Emails are sent in the background AFTER the reply, so a slow or broken mail
 * server never delays or fails a form. A failed email is tried 3 times, then
 * logged. The person still has their reference number on screen.
 */

export type EmailMessage = { to: string; subject: string; text: string; html: string };

/** Anything that can send one email. Tests pass a fake one. */
export type MailSender = {
  sendMail(message: EmailMessage & { from: string }): Promise<unknown>;
};

type Mailer = { sender: MailSender; from: string; kind: 'brevo' | 'smtp' | 'ethereal' };

export const EMAIL_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];
const DEVELOPMENT_FROM = 'Lepara Ale fele Moya <no-reply@lepara.test>';

/** An error with the same `code` names nodemailer uses, so both are handled alike. */
class MailServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MailServiceError';
  }
}

// --- Brevo's web API ------------------------------------------------------------------------

export const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** "Lepara Ale fele Moya <hello@example.org>" → { name, email }; a bare address → { email }. */
export function parseAddress(value: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1]!.replace(/^"|"$/g, '').trim();
  return name ? { name, email: match[2]!.trim() } : { email: match[2]!.trim() };
}

/**
 * Sends through https://api.brevo.com. A wrong key or a sender Brevo hasn't
 * confirmed won't fix itself, so those aren't retried; busy (429) and server
 * errors (5xx) are.
 */
export function brevoSender(apiKey: string, send: typeof fetch = fetch): MailSender {
  return {
    async sendMail(message) {
      const response = await send(BREVO_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: parseAddress(message.from),
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return (await response.json().catch(() => ({}))) as unknown;

      const reply = (await response.json().catch(() => ({}))) as { message?: unknown };
      const detail = typeof reply.message === 'string' ? `: ${reply.message.slice(0, 200)}` : '';
      const code =
        response.status === 401 || response.status === 403
          ? 'EAUTH'
          : response.status === 429 || response.status >= 500
            ? 'EBUSY'
            : 'EMESSAGE';
      throw new MailServiceError(`Brevo replied ${response.status}${detail}`, code);
    },
  };
}

// --- Choosing where emails go -----------------------------------------------------------

function smtpSender(host: string): MailSender {
  return createTransport({
    host,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // Give up on an unreachable server quickly; the retries below try again.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

async function etherealMailer(): Promise<Mailer | null> {
  try {
    const account = await createTestAccount();
    logger.info(
      'Emails go to a test inbox at ethereal.email (no real person receives them). ' +
        'Each email logs a link to read it.',
    );
    const sender = createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    return { sender, from: env.MAIL_FROM ?? DEVELOPMENT_FROM, kind: 'ethereal' };
  } catch (error) {
    logger.warn(
      { err: describeError(error) },
      'Could not open a test inbox at ethereal.email, so emails are only written to the log',
    );
    return null;
  }
}

let mailer: Promise<Mailer | null> | undefined;

function getMailer(): Promise<Mailer | null> {
  mailer ??= (async () => {
    if (env.NODE_ENV === 'test') return null; // tests never send real email
    const from = env.MAIL_FROM ?? DEVELOPMENT_FROM;
    if (env.BREVO_API_KEY) {
      logger.info("Emails are sent through Brevo's web API");
      return { sender: brevoSender(env.BREVO_API_KEY), from, kind: 'brevo' };
    }
    if (env.SMTP_HOST) {
      logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'Emails are sent through SMTP');
      return { sender: smtpSender(env.SMTP_HOST), from, kind: 'smtp' };
    }
    if (env.NODE_ENV === 'development') return etherealMailer();
    return null;
  })();
  return mailer;
}

/**
 * Tests only: send every email through this pretend mail service, to prove a
 * broken one never breaks a form. null goes back to the normal choice.
 */
export function setMailSenderForTests(sender: MailSender | null): void {
  mailer = sender ? Promise.resolve({ sender, from: DEVELOPMENT_FROM, kind: 'smtp' }) : undefined;
}

// --- Sending, with retries ------------------------------------------------------------

type MailError = {
  code?: unknown;
  responseCode?: unknown;
  message?: unknown;
  cause?: { code?: unknown };
};

/** Only what helps fix the problem: never the message itself or any password. */
function describeError(error: unknown): { code?: string; responseCode?: number; message: string } {
  const { code, responseCode, message, cause } = (error ?? {}) as MailError;
  const anyCode = typeof code === 'string' ? code : cause?.code;
  return {
    ...(typeof anyCode === 'string' ? { code: anyCode } : {}),
    ...(typeof responseCode === 'number' ? { responseCode } : {}),
    message: typeof message === 'string' ? message.slice(0, 300) : String(error),
  };
}

/**
 * Errors that will not fix themselves: a wrong password or key, an address or
 * sender the service refuses, or an SMTP 5xx "permanent failure" reply.
 * Trying again won't help.
 */
export function isPermanentMailError(error: unknown): boolean {
  const { code, responseCode } = (error ?? {}) as MailError;
  if (code === 'EAUTH' || code === 'EENVELOPE' || code === 'EMESSAGE') return true;
  return typeof responseCode === 'number' && responseCode >= 500;
}

/** "naledi@example.com" → "na***@example.com", so logs don't hold whole addresses. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address.slice(0, Math.min(2, at))}***${address.slice(at)}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one email, trying up to EMAIL_ATTEMPTS times with a pause between
 * tries. Throws the last error if every try fails.
 */
export async function deliver(
  sender: MailSender,
  message: EmailMessage & { from: string },
  { template, retryDelaysMs = RETRY_DELAYS_MS }: { template: string; retryDelaysMs?: number[] },
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sender.sendMail(message);
    } catch (error) {
      if (attempt >= EMAIL_ATTEMPTS || isPermanentMailError(error)) throw error;
      logger.warn(
        { template, attempt, err: describeError(error) },
        'Email could not be sent; trying again',
      );
      await wait(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0);
    }
  }
}

export type EmailOutcome = 'sent' | 'skipped' | 'failed';

/** Sends an email and reports what happened. Never throws. */
export async function sendEmail(message: EmailMessage, template: string): Promise<EmailOutcome> {
  const to = maskEmail(message.to);
  try {
    const chosen = await getMailer();
    if (!chosen) {
      if (env.NODE_ENV === 'production') {
        logger.warn({ template, to }, 'Email is not set up, so none was sent');
      } else {
        // Development without a test inbox: show the email in the log instead.
        logger.info(
          { template, to, subject: message.subject, text: message.text },
          'Email not sent (no email settings); this is what it says',
        );
      }
      return 'skipped';
    }

    const info = await deliver(chosen.sender, { ...message, from: chosen.from }, { template });
    if (chosen.kind === 'ethereal') {
      const preview = getTestMessageUrl(info as Parameters<typeof getTestMessageUrl>[0]);
      logger.info(
        { template, to, preview },
        'Email sent to the test inbox; open the link to read it',
      );
    } else {
      logger.info({ template, to }, 'Email sent');
    }
    return 'sent';
  } catch (error) {
    logger.error(
      { template, to, err: describeError(error) },
      isPermanentMailError(error)
        ? 'Email was refused (check the email settings and the address)'
        : `Email could not be sent after ${EMAIL_ATTEMPTS} tries`,
    );
    return 'failed';
  }
}

// --- In the background ------------------------------------------------------------------

const pending = new Set<Promise<EmailOutcome>>();

/** Sends after the reply has gone. The form never waits for, or fails because of, email. */
export function sendEmailInBackground(message: EmailMessage, template: string): void {
  const job: Promise<EmailOutcome> = sendEmail(message, template).finally(() => {
    pending.delete(job);
  });
  pending.add(job);
}

/** Lets emails still being sent finish, e.g. when the server is shutting down. */
export async function waitForPendingEmails(): Promise<void> {
  await Promise.allSettled([...pending]);
}
