import { withTransaction } from '../../config/db';
import { sendEmailInBackground } from '../../services/email';
import {
  assistanceRequestApproved,
  assistanceRequestDeclined,
  donationPledgeAccepted,
  donationPledgeDeclined,
  volunteerApplicationAccepted,
  volunteerApplicationDeclined,
} from '../../services/emailTemplates';
import { errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { todayInJohannesburg } from '../../utils/dates';
import { formatRand, numericToCents } from '../../utils/money';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import type { PageMeta } from '../../utils/respond';
import { formatDateLabel, formatTimeLabel } from '../initiatives/initiatives.format';
import * as repo from './reviews.repository';
import type { EnquiryRow, PledgeRow, RequestRow, VolunteerRow } from './reviews.repository';
import type {
  EnquiryListQuery,
  EnquiryStatusInput,
  PledgeDecision,
  PledgeListQuery,
  RequestDecision,
  RequestListQuery,
  VolunteerDecision,
  VolunteerListQuery,
} from './reviews.schemas';
import { type SubmissionKind, canMove, refusalMessage } from './reviews.transitions';

/**
 * The admin review queues: lists with filters, and decisions that follow the
 * Task 1 state machines (see reviews.transitions.ts).
 *
 * Every decision: locks the row, checks the move is allowed (409 if not),
 * saves the new status with who decided and when, writes an audit row, and
 * commits. Then, for accept/approve/decline, the person is emailed (if an
 * email address was given) and tracking shows the new status straight away.
 */

type Listed<Item> = { items: Item[]; meta: PageMeta };

const reviewer = (row: { reviewed_by: number | null; reviewed_by_name: string | null }) =>
  row.reviewed_by === null ? null : { adminId: row.reviewed_by, fullName: row.reviewed_by_name };

const slug = (status: string) => status.toLowerCase().replace(/\s+/g, '_');

function checkMove(kind: SubmissionKind, from: string, to: string): void {
  if (!canMove(kind, from, to)) throw errors.conflict(refusalMessage(kind, from, to));
}

// --- Volunteer applications ---------------------------------------------------------------

export type VolunteerItem = ReturnType<typeof toVolunteerItem>;

function toVolunteerItem(row: VolunteerRow) {
  return {
    applicationId: row.application_id,
    referenceNumber: row.reference_number,
    status: row.status,
    fullName: row.applicant_name,
    phone: row.contact_number,
    email: row.email,
    contribution: row.contribution_description,
    availability: row.availability_note,
    submittedAt: row.submitted_date,
    reviewedAt: row.reviewed_date,
    reviewedBy: reviewer(row),
    decisionReason: row.decision_reason,
    initiative: {
      initiativeId: row.initiative_id,
      title: row.initiative_title,
      startDate: row.start_date,
      endDate: row.end_date,
      dateLabel: formatDateLabel(row.start_date, row.end_date),
    },
    /** How full the task is: accepted volunteers against the number needed. */
    task:
      row.task_id === null
        ? null
        : {
            taskId: row.task_id,
            name: row.task_name,
            volunteersNeeded: row.volunteers_needed,
            accepted: row.task_accepted,
          },
  };
}

export async function listVolunteerApplications(
  filters: VolunteerListQuery,
): Promise<Listed<VolunteerItem>> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listVolunteerApplications({ ...filters, ...page });
  return {
    items: rows.map(toVolunteerItem),
    meta: pageMeta(filters.page, filters.pageSize, total),
  };
}

const applicationNotFound = () => errors.notFound("We couldn't find that application.");

export async function getVolunteerApplication(applicationId: number): Promise<VolunteerItem> {
  const row = await repo.findVolunteerApplication(applicationId);
  if (!row) throw applicationNotFound();
  return toVolunteerItem(row);
}

const ATTENDANCE = new Set(['Attended', 'Did not attend']);

export async function decideVolunteerApplication(
  adminId: number,
  applicationId: number,
  input: VolunteerDecision,
): Promise<VolunteerItem> {
  const row = await withTransaction(async (client) => {
    const current = await repo.findVolunteerApplication(applicationId, client, { lock: true });
    if (!current) throw applicationNotFound();
    checkMove('volunteer', current.status, input.status);

    // Whether someone came can only be known once the event has started.
    if (ATTENDANCE.has(input.status) && current.start_date > todayInJohannesburg()) {
      throw errors.conflict(
        'Attendance can be recorded from the first day of the event ' +
          `(${formatDateLabel(current.start_date, current.start_date)}).`,
      );
    }

    const reason = input.status === 'Declined' ? input.reason! : null;
    await repo.saveDecision(client, 'volunteer', applicationId, {
      status: input.status,
      adminId,
      reason,
    });
    await recordAudit(
      {
        adminId,
        action: `volunteer_application_${slug(input.status)}`,
        tableName: 'volunteer_application',
        recordId: applicationId,
        details: { from: current.status, to: input.status },
      },
      client,
    );
    return (await repo.findVolunteerApplication(applicationId, client))!;
  });

  if (row.email && input.status === 'Accepted') {
    sendEmailInBackground(
      volunteerApplicationAccepted({
        to: row.email,
        name: row.applicant_name,
        referenceNumber: row.reference_number,
        eventTitle: row.initiative_title,
        eventDate: formatDateLabel(row.start_date, row.end_date),
        eventTime: formatTimeLabel(row.start_time, row.end_time),
        location: row.location,
        taskName: row.task_name,
      }),
      'volunteer-application-accepted',
    );
  }
  if (row.email && input.status === 'Declined') {
    sendEmailInBackground(
      volunteerApplicationDeclined({
        to: row.email,
        name: row.applicant_name,
        referenceNumber: row.reference_number,
        eventTitle: row.initiative_title,
        reason: row.decision_reason ?? '',
      }),
      'volunteer-application-declined',
    );
  }
  return toVolunteerItem(row);
}

// --- Assistance requests ------------------------------------------------------------------

export type RequestItem = ReturnType<typeof toRequestItem>;

function toRequestItem(row: RequestRow) {
  return {
    requestId: row.request_id,
    referenceNumber: row.reference_number,
    status: row.status,
    fullName: row.applicant_name,
    phone: row.contact_number,
    email: row.email,
    requestType: row.request_type,
    description: row.description,
    submittedAt: row.submitted_date,
    reviewedAt: row.reviewed_date,
    reviewedBy: reviewer(row),
    decisionReason: row.decision_reason,
  };
}

export async function listAssistanceRequests(
  filters: RequestListQuery,
): Promise<Listed<RequestItem>> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listAssistanceRequests({ ...filters, ...page });
  return { items: rows.map(toRequestItem), meta: pageMeta(filters.page, filters.pageSize, total) };
}

const requestNotFound = () => errors.notFound("We couldn't find that request.");

/**
 * Opens a request. Task 1 (use case UC-03): opening a submitted request moves
 * it to Under review, recording which admin opened it and when.
 */
export async function openAssistanceRequest(
  adminId: number,
  requestId: number,
): Promise<RequestItem> {
  return withTransaction(async (client) => {
    if (await repo.markRequestUnderReview(client, requestId, adminId)) {
      await recordAudit(
        {
          adminId,
          action: 'assistance_request_opened',
          tableName: 'assistance_request',
          recordId: requestId,
          details: { from: 'Submitted', to: 'Under review' },
        },
        client,
      );
    }
    const row = await repo.findAssistanceRequest(requestId, client);
    if (!row) throw requestNotFound();
    return toRequestItem(row);
  });
}

export async function decideAssistanceRequest(
  adminId: number,
  requestId: number,
  input: RequestDecision,
): Promise<RequestItem> {
  const row = await withTransaction(async (client) => {
    const current = await repo.findAssistanceRequest(requestId, client, { lock: true });
    if (!current) throw requestNotFound();
    checkMove('request', current.status, input.status);

    await repo.saveDecision(client, 'request', requestId, {
      status: input.status,
      adminId,
      reason: input.status === 'Declined' ? input.reason! : null,
    });
    await recordAudit(
      {
        adminId,
        action: `assistance_request_${slug(input.status)}`,
        tableName: 'assistance_request',
        recordId: requestId,
        details: { from: current.status, to: input.status },
      },
      client,
    );
    return (await repo.findAssistanceRequest(requestId, client))!;
  });

  if (row.email && input.status === 'Approved') {
    sendEmailInBackground(
      assistanceRequestApproved({
        to: row.email,
        name: row.applicant_name,
        referenceNumber: row.reference_number,
        requestType: row.request_type,
      }),
      'assistance-request-approved',
    );
  }
  if (row.email && input.status === 'Declined') {
    sendEmailInBackground(
      assistanceRequestDeclined({
        to: row.email,
        name: row.applicant_name,
        referenceNumber: row.reference_number,
        requestType: row.request_type,
        reason: row.decision_reason ?? '',
      }),
      'assistance-request-declined',
    );
  }
  return toRequestItem(row);
}

// --- Donation pledges ---------------------------------------------------------------------

export type PledgeItem = ReturnType<typeof toPledgeItem>;

function toPledgeItem(row: PledgeRow) {
  const cents = row.estimated_value === null ? null : numericToCents(row.estimated_value);
  return {
    pledgeId: row.pledge_id,
    referenceNumber: row.reference_number,
    status: row.status,
    fullName: row.donor_name,
    email: row.email,
    phone: row.contact_number,
    category: row.category,
    description: row.description,
    estimatedValueCents: cents,
    estimatedValue: cents === null ? null : formatRand(cents),
    initiative:
      row.initiative_id === null
        ? null
        : { initiativeId: row.initiative_id, title: row.initiative_title },
    submittedAt: row.submitted_date,
    reviewedAt: row.reviewed_date,
    reviewedBy: reviewer(row),
    decisionReason: row.decision_reason,
  };
}

export async function listDonationPledges(filters: PledgeListQuery): Promise<Listed<PledgeItem>> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listDonationPledges({ ...filters, ...page });
  return { items: rows.map(toPledgeItem), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function decideDonationPledge(
  adminId: number,
  pledgeId: number,
  input: PledgeDecision,
): Promise<PledgeItem> {
  const row = await withTransaction(async (client) => {
    const current = await repo.findDonationPledge(pledgeId, client, { lock: true });
    if (!current) throw errors.notFound("We couldn't find that pledge.");
    checkMove('pledge', current.status, input.status);

    await repo.saveDecision(client, 'pledge', pledgeId, {
      status: input.status,
      adminId,
      reason: input.status === 'Declined' ? input.reason! : null,
    });
    await recordAudit(
      {
        adminId,
        action: `donation_pledge_${slug(input.status)}`,
        tableName: 'donation_pledge',
        recordId: pledgeId,
        details: { from: current.status, to: input.status },
      },
      client,
    );
    return (await repo.findDonationPledge(pledgeId, client))!;
  });

  sendEmailInBackground(
    input.status === 'Accepted'
      ? donationPledgeAccepted({
          to: row.email,
          name: row.donor_name,
          referenceNumber: row.reference_number,
          category: row.category,
          eventTitle: row.initiative_title,
        })
      : donationPledgeDeclined({
          to: row.email,
          name: row.donor_name,
          referenceNumber: row.reference_number,
          category: row.category,
          reason: row.decision_reason ?? '',
        }),
    `donation-pledge-${slug(input.status)}`,
  );
  return toPledgeItem(row);
}

// --- Enquiries ----------------------------------------------------------------------------

export type EnquiryItem = ReturnType<typeof toEnquiryItem>;

function toEnquiryItem(row: EnquiryRow) {
  return {
    enquiryId: row.enquiry_id,
    status: row.status,
    fullName: row.contact_name,
    email: row.email,
    phone: row.contact_number,
    enquiryType: row.enquiry_type,
    message: row.message,
    submittedAt: row.submitted_date,
  };
}

export async function listEnquiries(filters: EnquiryListQuery): Promise<Listed<EnquiryItem>> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listEnquiries({ ...filters, ...page });
  return { items: rows.map(toEnquiryItem), meta: pageMeta(filters.page, filters.pageSize, total) };
}

/** Marks an enquiry Reviewed (or New again, to come back to it). No email is sent. */
export async function setEnquiryStatus(
  adminId: number,
  enquiryId: number,
  input: EnquiryStatusInput,
): Promise<EnquiryItem> {
  return withTransaction(async (client) => {
    const current = await repo.findEnquiry(enquiryId, client, { lock: true });
    if (!current) throw errors.notFound("We couldn't find that enquiry.");
    if (current.status === input.status) return toEnquiryItem(current);

    await repo.setEnquiryStatus(client, enquiryId, input.status);
    await recordAudit(
      {
        adminId,
        action: input.status === 'Reviewed' ? 'enquiry_reviewed' : 'enquiry_reopened',
        tableName: 'enquiry',
        recordId: enquiryId,
        details: { from: current.status, to: input.status },
      },
      client,
    );
    return toEnquiryItem({ ...current, status: input.status });
  });
}
