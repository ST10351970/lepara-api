import type { EmailMessage } from './email';

/**
 * One function per email the API sends. Each returns the subject, a plain-text
 * version and an HTML version (email apps show whichever they support).
 *
 * Safety rules for every template:
 *  - Anything that came from a person or an admin is escaped in the HTML.
 *  - Free text people typed (descriptions, messages) is never copied into an
 *    email, so the forms can't be used to send someone else spam.
 *  - Subjects contain only fixed words and reference numbers.
 *  - The one exception to the free-text rule: an order email repeats the
 *    delivery address, because it only ever goes to the signed-in customer's
 *    own confirmed email address, so they can check where it is going.
 */

export const ORGANISATION = 'Lepara Ale fele Moya';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** A line break or tab in a value would break the layout (or an email header). */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

type Block = { text: string; html: string };

const paragraph = (text: string): Block => ({
  text,
  html: `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`,
});

/** The reference number, large and easy to copy. */
const referenceBox = (referenceNumber: string): Block => ({
  text: `Your reference number: ${referenceNumber}`,
  html:
    '<p style="margin:0 0 4px;color:#555">Your reference number</p>' +
    '<p style="margin:0 0 16px;font-size:24px;font-weight:bold;letter-spacing:2px;' +
    `font-family:monospace">${escapeHtml(referenceNumber)}</p>`,
});

/** "Event: Community clothing drive" rows. */
const details = (rows: Array<[string, string | null | undefined]>): Block => {
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));
  return {
    text: shown.map(([label, value]) => `${label}: ${oneLine(value)}`).join('\n'),
    html:
      '<table style="margin:0 0 16px;border-collapse:collapse">' +
      shown
        .map(
          ([label, value]) =>
            `<tr><td style="padding:2px 12px 2px 0;color:#555">${escapeHtml(label)}</td>` +
            `<td style="padding:2px 0">${escapeHtml(oneLine(value))}</td></tr>`,
        )
        .join('') +
      '</table>',
  };
};

const SIGN_OFF = `Warm regards,\nThe ${ORGANISATION} team`;
const NOT_YOU = "If you didn't fill in this form, you can ignore this email.";

function build(
  to: string,
  subject: string,
  name: string,
  blocks: Block[],
  footer: string = NOT_YOU,
): EmailMessage {
  const greeting = `Hi ${oneLine(name)},`;
  const all = [paragraph(greeting), ...blocks];
  const text = [...all.map((block) => block.text), SIGN_OFF, footer].join('\n\n');
  const html =
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6">' +
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">' +
    `<p style="margin:0 0 24px;font-weight:bold;font-size:18px">${ORGANISATION}</p>` +
    all.map((block) => block.html).join('') +
    `<p style="margin:24px 0 0">${escapeHtml(SIGN_OFF).replace('\n', '<br>')}</p>` +
    `<p style="margin:24px 0 0;font-size:12px;color:#777">${escapeHtml(footer)}</p>` +
    '</div></body></html>';
  return { to, subject: oneLine(subject), text, html };
}

const keepReference = (what: string): Block =>
  paragraph(
    'Please keep this reference number. With the last 4 digits of your phone number, ' +
      `you can use it to check on your ${what}.`,
  );

// --- The emails ------------------------------------------------------------------------

export function volunteerApplicationReceived(data: {
  to: string;
  name: string;
  referenceNumber: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string | null;
  location: string | null;
  taskName: string | null;
}): EmailMessage {
  return build(data.to, `Volunteer application received: ${data.referenceNumber}`, data.name, [
    paragraph(`Thank you for offering to volunteer with ${ORGANISATION}.`),
    referenceBox(data.referenceNumber),
    details([
      ['Event', data.eventTitle],
      ['Date', data.eventDate],
      ['Time', data.eventTime],
      ['Place', data.location],
      ['Task', data.taskName],
    ]),
    paragraph('Our team will review your application and contact you to confirm your task.'),
    keepReference('application'),
  ]);
}

export function donationPledgeReceived(data: {
  to: string;
  name: string;
  referenceNumber: string;
  category: string;
  eventTitle: string | null;
}): EmailMessage {
  return build(data.to, `Donation pledge received: ${data.referenceNumber}`, data.name, [
    paragraph(`Thank you for offering a donation to ${ORGANISATION}.`),
    referenceBox(data.referenceNumber),
    details([
      ['Donation type', data.category],
      ['For', data.eventTitle],
    ]),
    paragraph(
      'Our team will contact you to arrange the next steps. ' +
        'No payment is collected through this form.',
    ),
    keepReference('pledge'),
  ]);
}

export function assistanceRequestReceived(data: {
  to: string;
  name: string;
  referenceNumber: string;
  requestType: string;
}): EmailMessage {
  return build(data.to, `Request received: ${data.referenceNumber}`, data.name, [
    paragraph(`We have received your request for help from ${ORGANISATION}.`),
    referenceBox(data.referenceNumber),
    details([['Help with', data.requestType]]),
    paragraph('Our team will review your request and contact you about the next steps.'),
    keepReference('request'),
  ]);
}

export function enquiryReceived(data: {
  to: string;
  name: string;
  enquiryType: 'Donor' | 'Partner';
}): EmailMessage {
  const about = data.enquiryType === 'Partner' ? 'partnering with us' : 'donating';
  return build(data.to, 'We have received your enquiry', data.name, [
    paragraph(`Thank you for your enquiry about ${about}.`),
    paragraph('Our team will reply to this email address as soon as we can.'),
  ]);
}

// --- Decisions (step 12) ------------------------------------------------------------------

export function volunteerApplicationAccepted(data: {
  to: string;
  name: string;
  referenceNumber: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string | null;
  location: string | null;
  taskName: string | null;
}): EmailMessage {
  return build(data.to, `Volunteer application accepted: ${data.referenceNumber}`, data.name, [
    paragraph(`Good news: your application to volunteer with ${ORGANISATION} has been accepted.`),
    details([
      ['Reference', data.referenceNumber],
      ['Event', data.eventTitle],
      ['Date', data.eventDate],
      ['Time', data.eventTime],
      ['Place', data.location],
      ['Task', data.taskName],
    ]),
    paragraph('Thank you for giving your time. The team will contact you if anything changes.'),
  ]);
}

export function volunteerApplicationDeclined(data: {
  to: string;
  name: string;
  referenceNumber: string;
  eventTitle: string;
  reason: string;
}): EmailMessage {
  const subject = `Update on your volunteer application: ${data.referenceNumber}`;
  return build(data.to, subject, data.name, [
    paragraph(
      `Thank you for offering to volunteer at ${oneLine(data.eventTitle)}. ` +
        "Unfortunately we can't accept your application this time.",
    ),
    details([
      ['Reference', data.referenceNumber],
      ['Reason', data.reason],
    ]),
    paragraph('We hope you will apply for one of our future events.'),
  ]);
}

export function assistanceRequestApproved(data: {
  to: string;
  name: string;
  referenceNumber: string;
  requestType: string;
}): EmailMessage {
  return build(data.to, `Request approved: ${data.referenceNumber}`, data.name, [
    paragraph('Your request for help has been approved.'),
    details([
      ['Reference', data.referenceNumber],
      ['Help with', data.requestType],
    ]),
    paragraph('Our team will contact you about the next steps.'),
  ]);
}

export function assistanceRequestDeclined(data: {
  to: string;
  name: string;
  referenceNumber: string;
  requestType: string;
  reason: string;
}): EmailMessage {
  return build(data.to, `Update on your request: ${data.referenceNumber}`, data.name, [
    paragraph("Thank you for contacting us. Unfortunately we're unable to help with this request."),
    details([
      ['Reference', data.referenceNumber],
      ['Help with', data.requestType],
      ['Reason', data.reason],
    ]),
    paragraph('If your situation changes, you are welcome to send a new request.'),
  ]);
}

export function donationPledgeAccepted(data: {
  to: string;
  name: string;
  referenceNumber: string;
  category: string;
  eventTitle: string | null;
}): EmailMessage {
  return build(data.to, `Donation pledge accepted: ${data.referenceNumber}`, data.name, [
    paragraph('Thank you! Your donation pledge has been accepted.'),
    details([
      ['Reference', data.referenceNumber],
      ['Donation type', data.category],
      ['For', data.eventTitle],
    ]),
    paragraph(
      'Our team will contact you to arrange the donation. ' +
        'No payment is collected by email or through the app.',
    ),
  ]);
}

export function donationPledgeDeclined(data: {
  to: string;
  name: string;
  referenceNumber: string;
  category: string;
  reason: string;
}): EmailMessage {
  return build(data.to, `Update on your donation pledge: ${data.referenceNumber}`, data.name, [
    paragraph("Thank you for your generous offer. Unfortunately we're unable to accept it."),
    details([
      ['Reference', data.referenceNumber],
      ['Donation type', data.category],
      ['Reason', data.reason],
    ]),
    paragraph('We hope you will consider supporting one of our future drives.'),
  ]);
}

// --- Donations (step 13) ------------------------------------------------------------------

export function donationPledgeReceivedThankYou(data: {
  to: string;
  name: string;
  referenceNumber: string;
  category: string;
}): EmailMessage {
  return build(data.to, `Thank you for your donation: ${data.referenceNumber}`, data.name, [
    paragraph(`We have received your donation. Thank you for supporting ${ORGANISATION}!`),
    details([
      ['Reference', data.referenceNumber],
      ['Donation type', data.category],
    ]),
  ]);
}

// --- Customer accounts (step 14) ----------------------------------------------------------

/** The 6-digit code, large and easy to copy. */
const codeBox = (code: string): Block => ({
  text: `Your code: ${code}`,
  html:
    '<p style="margin:0 0 4px;color:#555">Your code</p>' +
    '<p style="margin:0 0 16px;font-size:28px;font-weight:bold;letter-spacing:6px;' +
    `font-family:monospace">${escapeHtml(code)}</p>`,
});

const codeExpiry = paragraph(
  'The code works for 10 minutes. Never share it: our team will never ask you for it.',
);

export function customerSignUpCode(data: { to: string; name: string; code: string }) {
  return build(data.to, `Confirm your email for ${ORGANISATION}`, data.name, [
    paragraph('Welcome! Enter this code in the app to confirm your email address.'),
    codeBox(data.code),
    codeExpiry,
  ]);
}

export function customerAlreadyRegistered(data: { to: string; name: string }) {
  return build(data.to, `You already have an account with ${ORGANISATION}`, data.name, [
    paragraph(
      'Someone tried to create a new account with this email address, but you already have one.',
    ),
    paragraph(
      'Please sign in instead. If you have forgotten your password, choose "Forgot password" ' +
        'on the sign-in screen.',
    ),
  ]);
}

export function customerLoginCode(data: { to: string; name: string; code: string }) {
  return build(data.to, `Your sign-in code for ${ORGANISATION}`, data.name, [
    paragraph('Enter this code in the app to finish signing in.'),
    codeBox(data.code),
    codeExpiry,
    paragraph("If you didn't just try to sign in, change your password straight away."),
  ]);
}

export function customerPasswordResetCode(data: { to: string; name: string; code: string }) {
  return build(data.to, `Reset your ${ORGANISATION} password`, data.name, [
    paragraph('Enter this code in the app to choose a new password.'),
    codeBox(data.code),
    codeExpiry,
  ]);
}

export function customerEmailChangeCode(data: { to: string; name: string; code: string }) {
  return build(data.to, `Confirm your new email for ${ORGANISATION}`, data.name, [
    paragraph('Enter this code in the app to start using this email address for your account.'),
    codeBox(data.code),
    codeExpiry,
  ]);
}

export function customerEmailAlreadyUsed(data: { to: string; name: string }) {
  return build(data.to, 'Someone asked to use your email address', data.name, [
    paragraph(
      'Someone asked to move another account to this email address, but it already belongs ' +
        'to your account. Nothing has changed.',
    ),
  ]);
}

export function customerPasswordChanged(data: { to: string; name: string }) {
  return build(data.to, `Your ${ORGANISATION} password was changed`, data.name, [
    paragraph('Your password was just changed, and you have been signed out on other devices.'),
    paragraph(
      "If this wasn't you, reset your password straight away with \"Forgot password\" " +
        'on the sign-in screen.',
    ),
  ]);
}

export function customerAccountDeleted(data: { to: string; name: string }) {
  return build(data.to, `Your ${ORGANISATION} account was deleted`, data.name, [
    paragraph(
      'Your account has been deleted and your personal details removed from it. Past orders, ' +
        'with the delivery details given for them, are kept for our financial records.',
    ),
    paragraph('Thank you for supporting us. You are welcome to create a new account at any time.'),
  ]);
}

// --- Shop orders (step 15) ---------------------------------------------------------------

const ORDER_FOOTER = `You received this email because an order was placed with your ${ORGANISATION} account.`;

/** The order number, large and easy to copy: it is also the EFT payment reference. */
const orderNumberBox = (orderNumber: string): Block => ({
  text: `Your order number: ${orderNumber}`,
  html:
    '<p style="margin:0 0 4px;color:#555">Your order number</p>' +
    '<p style="margin:0 0 16px;font-size:24px;font-weight:bold;letter-spacing:2px;' +
    `font-family:monospace">${escapeHtml(orderNumber)}</p>`,
});

export type BankDetails = {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchCode: string;
};

export type OrderEmail = {
  to: string;
  name: string;
  orderNumber: string;
  items: Array<{ name: string; size: string; quantity: number; lineTotal: string }>;
  subtotal: string;
  deliveryFee: string;
  total: string;
  /** "Naledi Mokoena, 18 Mofolo Street, Soweto, 1801" */
  deliveryAddress: string;
  paymentMethod: 'EFT' | 'Cash on delivery';
  bank: BankDetails | null;
};

const sizeText = (size: string) => (size === 'One size' ? 'one size' : `size ${size}`);

function orderSummary(data: OrderEmail): Block[] {
  return [
    details([
      ...data.items.map(
        (item): [string, string] => [
          `${item.quantity} × ${item.name} (${sizeText(item.size)})`,
          item.lineTotal,
        ],
      ),
      ['Subtotal', data.subtotal],
      ['Delivery', data.deliveryFee],
      ['Total', data.total],
    ]),
    details([['Deliver to', data.deliveryAddress]]),
  ];
}

export function orderPlaced(data: OrderEmail): EmailMessage {
  if (data.paymentMethod === 'EFT') {
    return build(
      data.to,
      `Order received: ${data.orderNumber}`,
      data.name,
      [
        paragraph('Thank you for your order! Here is a summary.'),
        orderNumberBox(data.orderNumber),
        ...orderSummary(data),
        paragraph(
          `Please pay ${data.total} by EFT, with ${data.orderNumber} as the payment reference ` +
            'so we can match your payment to your order.',
        ),
        data.bank
          ? details([
              ['Bank', data.bank.bankName],
              ['Account name', data.bank.accountName],
              ['Account number', data.bank.accountNumber],
              ['Branch code', data.bank.branchCode],
              ['Reference', data.orderNumber],
              ['Amount', data.total],
            ])
          : paragraph('Reply to this email if you need our banking details.'),
        paragraph(
          "We'll confirm your order as soon as the payment arrives, then pack it and send it. " +
            'You can follow it on the Orders tab in the app.',
        ),
      ],
      ORDER_FOOTER,
    );
  }
  return build(
    data.to,
    `Order confirmed: ${data.orderNumber}`,
    data.name,
    [
      paragraph("Thank you for your order! We're getting it ready. Here is a summary."),
      orderNumberBox(data.orderNumber),
      ...orderSummary(data),
      paragraph(`Please have ${data.total} in cash ready to pay the delivery driver.`),
      paragraph('You can follow your order on the Orders tab in the app.'),
    ],
    ORDER_FOOTER,
  );
}

export function orderCancelled(data: { to: string; name: string; orderNumber: string }) {
  return build(
    data.to,
    `Order cancelled: ${data.orderNumber}`,
    data.name,
    [
      paragraph(`Your order ${data.orderNumber} has been cancelled, as you asked.`),
      paragraph('Nothing is owed for it. You are welcome to order again at any time.'),
    ],
    ORDER_FOOTER,
  );
}
