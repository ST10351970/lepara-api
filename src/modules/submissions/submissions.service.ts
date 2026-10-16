import type { PoolClient } from 'pg';
import { withSavepoint, withTransaction } from '../../config/db';
import { sendEmailInBackground } from '../../services/email';
import {
  assistanceRequestReceived,
  donationPledgeReceived,
  enquiryReceived,
  volunteerApplicationReceived,
} from '../../services/emailTemplates';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { todayInJohannesburg } from '../../utils/dates';
import { centsToNumeric } from '../../utils/money';
import { constraintOf } from '../../utils/pgErrors';
import {
  ReferencePrefix,
  generateReference,
  withUniqueReference,
} from '../../utils/referenceNumber';
import { formatDateLabel, formatTimeLabel } from '../initiatives/initiatives.format';
import * as repo from './submissions.repository';
import type { EventForForm } from './submissions.repository';
import type {
  AssistanceRequestInput,
  DonationPledgeInput,
  EnquiryInput,
  VolunteerApplicationInput,
} from './submissions.schemas';

/**
 * The four public forms. Each one: check the business rules, save with a
 * reference number (a new one is drawn if it clashes), commit, then email
 * the reference if an address was given. The reply carries the reference
 * number whether or not the email works.
 */

/** What every form replies with (201). Enquiries have no reference number. */
export type SubmissionReceipt = {
  referenceNumber: string | null;
  status: string;
  submittedAt: Date;
  /** A ready-made thank-you line for the screen. */
  message: string;
};

// --- Rules about the chosen event --------------------------------------------------------

const fieldError = (field: string, message: string) => errors.validation([{ field, message }]);

/**
 * Why an event can't take this form, or null if it can. Drafts and missing
 * events get the same answer, so drafts stay hidden.
 */
function eventClosedReason(event: EventForForm | null, today: string): string | null {
  if (!event || event.status === 'Draft') return 'Please choose one of the upcoming events.';
  if (event.status === 'Closed' || event.end_date < today) {
    return 'This event has already ended. Please choose an upcoming event.';
  }
  return null;
}

async function openEvent(client: PoolClient, initiativeId: number): Promise<EventForForm> {
  const event = await repo.lockEventForForm(client, initiativeId);
  const reason = eventClosedReason(event, todayInJohannesburg());
  if (reason) throw fieldError('initiativeId', reason);
  return event!;
}

/** Inside a transaction: the insert is retried with a new reference number after a clash. */
const insertWithReference = <T>(
  client: PoolClient,
  prefix: ReferencePrefix,
  insert: (referenceNumber: string) => Promise<T>,
) => withUniqueReference(prefix, (reference) => withSavepoint(client, () => insert(reference)));

// --- Volunteer applications --------------------------------------------------------------

const alreadyApplied = () =>
  new AppError(
    409,
    ErrorCode.CONFLICT,
    'You have already applied to volunteer at this event. Our team will be in touch.',
    [
      {
        field: 'phone',
        message:
          'An application from this phone number for this event is already waiting for review.',
      },
    ],
  );

export async function submitVolunteerApplication(
  input: VolunteerApplicationInput,
): Promise<SubmissionReceipt> {
  const saved = await withTransaction(async (client) => {
    const event = await openEvent(client, input.initiativeId);
    if (!event.volunteers_required) {
      throw fieldError(
        'initiativeId',
        "This event isn't looking for volunteers. You can still donate or come along.",
      );
    }

    const tasks = await repo.listEventTasks(client, event.initiative_id);
    const task = input.taskId === undefined ? null : tasks.find((t) => t.task_id === input.taskId);
    if (task === undefined) throw fieldError('taskId', "Please choose one of this event's tasks.");
    if (task === null && tasks.length > 0) throw fieldError('taskId', 'Please choose a task.');

    let referenceNumber = '';
    const row = await insertWithReference(client, ReferencePrefix.volunteerApplication, (ref) => {
      referenceNumber = ref;
      return repo.insertVolunteerApplication(client, {
        referenceNumber: ref,
        initiativeId: event.initiative_id,
        taskId: task?.task_id ?? null,
        name: input.fullName,
        phone: input.phone,
        email: input.email ?? null,
        contribution: input.contribution,
        availability: input.availability,
      });
    });
    return { event, task, referenceNumber, submittedAt: row.submitted_date };
  }).catch((error: unknown) => {
    if (constraintOf(error) === 'volunteer_application_pending_key') throw alreadyApplied();
    throw error;
  });

  const { event, task, referenceNumber } = saved;
  if (input.email) {
    sendEmailInBackground(
      volunteerApplicationReceived({
        to: input.email,
        name: input.fullName,
        referenceNumber,
        eventTitle: event.title,
        eventDate: formatDateLabel(event.start_date, event.end_date),
        eventTime: formatTimeLabel(event.start_time, event.end_time),
        location: event.location,
        taskName: task?.task_name ?? null,
      }),
      'volunteer-application-received',
    );
  }

  const what = task ? `to help with ${task.task_name} at ${event.title}` : `for ${event.title}`;
  return {
    referenceNumber,
    status: 'Submitted',
    submittedAt: saved.submittedAt,
    message:
      `Thank you. Your application ${what} has been sent for review. ` +
      `Your reference number is ${referenceNumber}.`,
  };
}

// --- Donation pledges --------------------------------------------------------------------

export async function submitDonationPledge(input: DonationPledgeInput): Promise<SubmissionReceipt> {
  const saved = await withTransaction(async (client) => {
    const event =
      input.initiativeId === undefined ? null : await openEvent(client, input.initiativeId);

    let referenceNumber = '';
    const row = await insertWithReference(client, ReferencePrefix.donationPledge, (reference) => {
      referenceNumber = reference;
      return repo.insertDonationPledge(client, {
        referenceNumber: reference,
        initiativeId: event?.initiative_id ?? null,
        name: input.fullName,
        email: input.email,
        phone: input.phone,
        category: input.category,
        description: input.description,
        estimatedValue:
          input.estimatedValue === undefined ? null : centsToNumeric(input.estimatedValue),
      });
    });
    return { event, referenceNumber, row };
  });

  const { event, referenceNumber, row } = saved;
  sendEmailInBackground(
    donationPledgeReceived({
      to: input.email,
      name: input.fullName,
      referenceNumber,
      category: input.category,
      eventTitle: event?.title ?? null,
    }),
    'donation-pledge-received',
  );

  return {
    referenceNumber,
    status: row.status,
    submittedAt: row.submitted_date,
    message:
      'Thank you. Your donation pledge has been sent for review. ' +
      `Your reference number is ${referenceNumber}. No payment is collected through this form.`,
  };
}

// --- Assistance requests -----------------------------------------------------------------

export async function submitAssistanceRequest(
  input: AssistanceRequestInput,
): Promise<SubmissionReceipt> {
  let referenceNumber = '';
  const row = await withUniqueReference(ReferencePrefix.assistanceRequest, (reference) => {
    referenceNumber = reference;
    return repo.insertAssistanceRequest({
      referenceNumber: reference,
      name: input.fullName,
      phone: input.phone,
      email: input.email ?? null,
      requestType: input.requestType,
      description: input.description,
    });
  });

  if (input.email) {
    sendEmailInBackground(
      assistanceRequestReceived({
        to: input.email,
        name: input.fullName,
        referenceNumber,
        requestType: input.requestType,
      }),
      'assistance-request-received',
    );
  }

  return {
    referenceNumber,
    status: 'Submitted',
    submittedAt: row.submitted_date,
    message:
      `Thank you. Your request has been received. Your reference number is ${referenceNumber}. ` +
      'Our team will contact you.',
  };
}

// --- Enquiries ---------------------------------------------------------------------------

export async function submitEnquiry(input: EnquiryInput): Promise<SubmissionReceipt> {
  const row = await repo.insertEnquiry({
    name: input.fullName,
    phone: input.phone ?? null,
    email: input.email,
    enquiryType: input.enquiryType,
    message: input.message,
  });

  sendEmailInBackground(
    enquiryReceived({ to: input.email, name: input.fullName, enquiryType: input.enquiryType }),
    'enquiry-received',
  );

  return {
    referenceNumber: null,
    status: 'New',
    submittedAt: row.submitted_date,
    message: 'Thank you. Your enquiry has been received. We will reply to your email address.',
  };
}

// --- Spam trap ---------------------------------------------------------------------------

/**
 * The reply a bot gets when it fills in the hidden "website" field: it looks
 * like success, but nothing was saved and no email was sent.
 */
export function pretendReceipt(prefix: ReferencePrefix | null): SubmissionReceipt {
  const referenceNumber = prefix ? generateReference(prefix) : null;
  return {
    referenceNumber,
    status: prefix === ReferencePrefix.donationPledge ? 'Pending' : prefix ? 'Submitted' : 'New',
    submittedAt: new Date(),
    message: referenceNumber
      ? `Thank you. Your form has been sent for review. Your reference number is ${referenceNumber}.`
      : 'Thank you. Your enquiry has been received. We will reply to your email address.',
  };
}
