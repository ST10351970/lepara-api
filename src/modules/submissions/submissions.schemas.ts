import { z } from 'zod';
import {
  consentGiven,
  emailAddress,
  oneOf,
  personName,
  randsToCents,
  requiredText,
  saPhoneNumber,
  shortText,
} from '../../schemas/common';
import {
  ASSISTANCE_REQUEST_TYPE_VALUES,
  DONATION_CATEGORY_VALUES,
  ENQUIRY_TYPE_VALUES,
} from './submissions.options';

/**
 * The four public forms. Every message is written for the person filling in
 * the form. Unknown fields (including the hidden "website" field) are dropped.
 */

/** Forms often send "" or null for a field left empty: treat both as "not given". */
function optional<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    schema.optional(),
  );
}

/** An event or task picked from a list. Accepts 12 or "12". */
function choiceId(message: string) {
  return z.preprocess(
    (value) =>
      typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value) : value,
    z.number({ error: message }).int(message).positive(message).max(2_147_483_647, message),
  );
}

/** A box people type a few sentences into: 10 to 1,000 characters. */
function writtenText(missingMessage: string) {
  return requiredText(missingMessage)
    .trim()
    .min(1, missingMessage)
    .min(10, 'Please tell us a little more (at least 10 characters).')
    .max(1000, 'Please keep this under 1,000 characters.');
}

const fullName = personName('your full name', 100);

/** The email columns on these tables hold up to 150 characters. */
const email = emailAddress.max(150, 'That email address is too long.');

/** POST /volunteer-applications */
export const volunteerApplicationSchema = z.object({
  initiativeId: choiceId('Please choose an event.'),
  /** Required when the event has tasks (published events always do). */
  taskId: optional(choiceId('Please choose a task.')),
  fullName,
  phone: saPhoneNumber,
  email: optional(email),
  contribution: writtenText('Please describe how you would like to help.'),
  availability: shortText('Please say when you are available.', 3, 200),
  consent: consentGiven,
});

/** POST /donation-pledges */
export const donationPledgeSchema = z.object({
  fullName,
  email,
  phone: saPhoneNumber,
  /** Leave empty for a general donation, not for one event. */
  initiativeId: optional(choiceId('Please choose one of the upcoming events.')),
  category: oneOf(DONATION_CATEGORY_VALUES),
  description: writtenText('Please describe your donation.'),
  /** In rands, e.g. 1200 or "1200.50"; stored as cents. 0 to R1,000,000. */
  estimatedValue: optional(randsToCents(1_000_000)),
  consent: consentGiven,
});

/** POST /assistance-requests */
export const assistanceRequestSchema = z.object({
  fullName,
  phone: saPhoneNumber,
  email: optional(email),
  requestType: oneOf(ASSISTANCE_REQUEST_TYPE_VALUES),
  description: writtenText('Please describe the help you need.'),
  consent: consentGiven,
});

/** POST /enquiries */
export const enquirySchema = z.object({
  fullName,
  email,
  phone: optional(saPhoneNumber),
  enquiryType: oneOf(ENQUIRY_TYPE_VALUES),
  message: writtenText('Please write your message.'),
  consent: consentGiven,
});

export type VolunteerApplicationInput = z.infer<typeof volunteerApplicationSchema>;
export type DonationPledgeInput = z.infer<typeof donationPledgeSchema>;
export type AssistanceRequestInput = z.infer<typeof assistanceRequestSchema>;
export type EnquiryInput = z.infer<typeof enquirySchema>;
