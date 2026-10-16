import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Push notifications through Firebase Cloud Messaging (FCM), with the
 * firebase-admin library. This file is the only place that talks to Firebase.
 *
 *  - FIREBASE_SERVICE_ACCOUNT set: messages go through Firebase.
 *  - Not set (or in tests): no sender, and the notifications are skipped. The
 *    API works normally either way.
 *
 * Firebase is loaded only when the first notification is sent, so starting the
 * API stays quick and a missing Firebase setup can never stop it.
 */

/** FCM accepts at most 500 devices per request. */
export const PUSH_BATCH_SIZE = 500;

export type PushMessage = {
  title: string;
  body: string;
  /** Extra values for the app (all text), e.g. { type: 'order', orderNumber: 'LAFM-1008' }. */
  data?: Record<string, string>;
};

export type PushResult = { token: string; ok: boolean; invalidToken: boolean; error?: string };

/** Sends one message to up to 500 devices; one result per token, in the same order. */
export type PushSender = (tokens: string[], message: PushMessage) => Promise<PushResult[]>;

/** The part of firebase-admin's Messaging that is used, so tests can pass their own. */
export type MessagingLike = {
  sendEachForMulticast(message: {
    tokens: string[];
    notification: { title: string; body: string };
    data?: Record<string, string>;
    android?: { priority: 'high' | 'normal' };
    apns?: { payload: { aps: { sound: string } } };
  }): Promise<{
    responses: Array<{ success: boolean; error?: { code: string; message: string } }>;
  }>;
};

/** FCM's answer when a device uninstalled the app or the token was never valid. */
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export function fcmSender(messaging: MessagingLike): PushSender {
  return async (tokens, message) => {
    const reply = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      ...(message.data ? { data: message.data } : {}),
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    return reply.responses.map((response, index) => ({
      token: tokens[index]!,
      ok: response.success,
      invalidToken: !response.success && INVALID_TOKEN_CODES.has(response.error?.code ?? ''),
      ...(response.error ? { error: response.error.code } : {}),
    }));
  };
}

let chosen: Promise<PushSender | null> | undefined;
let replacement: PushSender | null | undefined;

/** The sender for this server, worked out once. Null means push notifications are off. */
export function getPushSender(): Promise<PushSender | null> {
  if (replacement !== undefined) return Promise.resolve(replacement);
  chosen ??= (async () => {
    if (env.NODE_ENV === 'test') return null;
    const account = env.FIREBASE_SERVICE_ACCOUNT;
    if (!account) {
      logger.info('Push notifications are off: FIREBASE_SERVICE_ACCOUNT is not set');
      return null;
    }
    try {
      const { cert, initializeApp } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      const app = initializeApp(
        {
          credential: cert({
            projectId: account.projectId,
            clientEmail: account.clientEmail,
            privateKey: account.privateKey,
          }),
        },
        'lepara-push',
      );
      logger.info(
        { projectId: account.projectId },
        'Push notifications are sent through Firebase',
      );
      return fcmSender(getMessaging(app) as unknown as MessagingLike);
    } catch (error) {
      logger.error({ err: error }, 'Could not start Firebase, so push notifications are off');
      return null;
    }
  })();
  return chosen;
}

/** For tests and check scripts only: use this sender instead (null turns push off). */
export function setPushSenderForTests(sender: PushSender | null | undefined): void {
  replacement = sender;
}

export type PushOutcome = { sent: number; failed: number; invalidTokens: string[] };

/**
 * Sends to every token, 500 at a time. Never throws: a batch that fails is
 * logged and counted, and the rest still go.
 */
export async function deliverPush(
  tokens: string[],
  message: PushMessage,
  sender: PushSender,
): Promise<PushOutcome> {
  const outcome: PushOutcome = { sent: 0, failed: 0, invalidTokens: [] };
  for (let start = 0; start < tokens.length; start += PUSH_BATCH_SIZE) {
    const batch = tokens.slice(start, start + PUSH_BATCH_SIZE);
    try {
      for (const result of await sender(batch, message)) {
        if (result.ok) {
          outcome.sent += 1;
        } else {
          outcome.failed += 1;
          if (result.invalidToken) outcome.invalidTokens.push(result.token);
        }
      }
    } catch (error) {
      outcome.failed += batch.length;
      logger.warn({ err: error, devices: batch.length }, 'A batch of push notifications failed');
    }
  }
  return outcome;
}
