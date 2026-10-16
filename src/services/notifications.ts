import * as devices from '../modules/devices/devices.repository';
import { logger } from '../utils/logger';
import { type PushMessage, deliverPush, getPushSender } from './push';

/**
 * Push notifications to the app (build guide step 17).
 *
 *  - A new announcement goes to every registered device.
 *  - An order status change goes to the devices where that customer is signed in.
 *  - Tokens that FCM says are invalid (app uninstalled) are deleted.
 *
 * These functions start the sending in the background and return at once, so
 * the admin's request never waits for Firebase. A failed send is logged, and
 * the change the admin made still stands.
 */

const pending = new Set<Promise<void>>();

function inBackground(work: Promise<void>): void {
  const job = work.finally(() => {
    pending.delete(job);
  });
  pending.add(job);
}

/** Lets notifications still being sent finish, e.g. when the server is shutting down. */
export async function waitForPendingNotifications(): Promise<void> {
  await Promise.allSettled([...pending]);
}

async function notify(
  kind: string,
  findTokens: () => Promise<string[]>,
  message: PushMessage,
): Promise<void> {
  try {
    const sender = await getPushSender();
    if (!sender) return;
    const tokens = await findTokens();
    if (tokens.length === 0) return;
    const outcome = await deliverPush(tokens, message, sender);
    const removed = await devices.deleteTokens(outcome.invalidTokens);
    logger.info(
      { kind, devices: tokens.length, sent: outcome.sent, failed: outcome.failed, removed },
      'Push notifications sent',
    );
  } catch (error) {
    logger.warn({ err: error, kind }, 'Push notifications could not be sent');
  }
}

/** "Winter blanket drive this Saturday at the community hall…" in at most 150 characters. */
export function preview(text: string, max = 150): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

export type AnnouncementNotice = { announcementId: number; title: string; body: string };

export async function announcementPublished(announcement: AnnouncementNotice): Promise<void> {
  inBackground(
    notify('announcement', () => devices.allDeviceTokens(), {
      title: `News: ${announcement.title}`,
      body: preview(announcement.body),
      data: { type: 'announcement', announcementId: String(announcement.announcementId) },
    }),
  );
}

/** An order moved to a new status (step 16): the customer's own devices only. */
export type OrderNotice = {
  customerId: number;
  orderNumber: string;
  status: string;
  /** e.g. "Order LAFM-1008: On the way" */
  title: string;
  body: string;
};

export async function orderStatusChanged(notice: OrderNotice): Promise<void> {
  inBackground(
    notify('order', () => devices.customerDeviceTokens(notice.customerId), {
      title: notice.title,
      body: notice.body,
      data: { type: 'order', orderNumber: notice.orderNumber, status: notice.status },
    }),
  );
}
