/**
 * Push notifications to the app. Step 17 fills these in with real sending
 * (Firebase Cloud Messaging); until then they do nothing, so the places that
 * will send notifications are already wired up.
 *
 * These functions must never make a request fail: a notification that
 * can't be sent is logged, and the change the admin made still stands.
 */

export type AnnouncementNotice = { announcementId: number; title: string };

export async function announcementPublished(_announcement: AnnouncementNotice): Promise<void> {
  // Step 17: send "News: <title>" to every registered device.
}

/** An order moved to a new status (step 16): the customer's own devices only. */
export type OrderNotice = {
  customerId: number;
  orderNumber: string;
  status: string;
  /** e.g. "Order LAFM-1008 is on the way" */
  title: string;
  body: string;
};

export async function orderStatusChanged(_notice: OrderNotice): Promise<void> {
  // Step 17: send the title and body to every device registered to this customer.
}
