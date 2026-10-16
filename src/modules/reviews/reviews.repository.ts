import type { QueryResultRow } from 'pg';
import { type Queryable, pool, query } from '../../config/db';
import { likeContains, pickSort } from '../../utils/sql';

/**
 * Queries for the admin review queues. Values always go in as $1, $2, ...
 * Sort orders come only from the fixed lists below (pickSort).
 *
 * Date filters are whole days in Johannesburg: from 2026-10-01 to 2026-10-31
 * means 1 October 00:00 SAST up to the end of 31 October.
 */

const FROM_DAY = (column: string, param: string) =>
  `(${param}::date IS NULL OR ${column} >= (${param}::date::timestamp AT TIME ZONE 'Africa/Johannesburg'))`;
const TO_DAY = (column: string, param: string) =>
  `(${param}::date IS NULL OR ${column} < ((${param}::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg'))`;

/**
 * A search box value as two patterns: one for text, and one for phone
 * numbers, which are stored as +27712345678 but typed as 071 234 5678.
 */
function searchPatterns(search: string | undefined): { text: string | null; phone: string | null } {
  if (!search) return { text: null, phone: null };
  const digits = search.replace(/[\s()+-]/g, '');
  return {
    text: likeContains(search),
    phone: /^\d{3,}$/.test(digits) ? likeContains(digits) : null,
  };
}

/** Matches +27712345678 when 0712345678, 712345678 or 27712345678 is typed. */
const PHONE_MATCH = (column: string, param: string) =>
  `(${param}::text IS NOT NULL AND (${column} ILIKE ${param} OR ('0' || substr(${column}, 4)) ILIKE ${param}))`;

type Page = { limit: number; offset: number };
type Listed<Row> = { rows: Row[]; total: number };

async function pageAndCount<Row extends QueryResultRow>(
  select: string,
  where: string,
  countFrom: string,
  orderBy: string,
  values: unknown[],
  page: Page,
): Promise<Listed<Row>> {
  const n = values.length;
  const [rows, count] = await Promise.all([
    query<Row>(
      `${select} WHERE ${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...values, page.limit, page.offset],
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total ${countFrom} WHERE ${where}`, values),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.total ?? 0 };
}

export type Reviewer = { reviewed_by: number | null; reviewed_by_name: string | null };

// --- Volunteer applications ----------------------------------------------------------------

export type VolunteerRow = Reviewer & {
  application_id: number;
  reference_number: string;
  status: string;
  applicant_name: string;
  contact_number: string;
  email: string | null;
  contribution_description: string | null;
  availability_note: string | null;
  submitted_date: Date;
  reviewed_date: Date | null;
  decision_reason: string | null;
  initiative_id: number;
  initiative_title: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  task_id: number | null;
  task_name: string | null;
  volunteers_needed: number | null;
  /** Accepted applications for the same task, including ones since marked attended or not. */
  task_accepted: number;
};

const VOLUNTEER_SELECT = `SELECT v.application_id, v.reference_number, v.status, v.applicant_name,
    v.contact_number, v.email, v.contribution_description, v.availability_note, v.submitted_date,
    v.reviewed_date, v.decision_reason, v.reviewed_by, r.full_name AS reviewed_by_name,
    i.initiative_id, i.title AS initiative_title,
    i.start_date::text AS start_date, i.end_date::text AS end_date,
    to_char(i.start_time, 'HH24:MI') AS start_time, to_char(i.end_time, 'HH24:MI') AS end_time,
    i.location, k.initiative_task_id AS task_id, k.task_name, k.volunteers_needed,
    (SELECT count(*)::int FROM volunteer_application a
     WHERE a.initiative_task_id = v.initiative_task_id
       AND a.status IN ('Accepted', 'Attended', 'Did not attend')) AS task_accepted
  FROM volunteer_application v
  JOIN initiative i ON i.initiative_id = v.initiative_id
  LEFT JOIN initiative_task k ON k.initiative_task_id = v.initiative_task_id
  LEFT JOIN admin_user r ON r.admin_id = v.reviewed_by`;

const VOLUNTEER_SORTS = {
  newest: 'v.submitted_date DESC, v.application_id DESC',
  oldest: 'v.submitted_date ASC, v.application_id ASC',
  name: 'v.applicant_name ASC, v.application_id DESC',
  status: 'v.status ASC, v.submitted_date DESC, v.application_id DESC',
  event: 'i.start_date ASC, v.submitted_date DESC, v.application_id DESC',
};
export const VOLUNTEER_SORT_KEYS = Object.keys(VOLUNTEER_SORTS);

export async function listVolunteerApplications(
  filters: {
    status: string;
    initiativeId?: number;
    taskId?: number;
    from?: string;
    to?: string;
    search?: string;
    sort?: string;
  } & Page,
): Promise<Listed<VolunteerRow>> {
  const { text, phone } = searchPatterns(filters.search);
  const where = `($1::text = 'all' OR v.status = $1)
    AND ($2::int IS NULL OR v.initiative_id = $2)
    AND ($3::int IS NULL OR v.initiative_task_id = $3)
    AND ${FROM_DAY('v.submitted_date', '$4')}
    AND ${TO_DAY('v.submitted_date', '$5')}
    AND ($6::text IS NULL OR v.applicant_name ILIKE $6 OR v.email ILIKE $6
         OR v.reference_number ILIKE $6 OR ${PHONE_MATCH('v.contact_number', '$7')})`;
  return pageAndCount<VolunteerRow>(
    VOLUNTEER_SELECT,
    where,
    'FROM volunteer_application v',
    pickSort(filters.sort, VOLUNTEER_SORTS, 'newest'),
    [
      filters.status,
      filters.initiativeId ?? null,
      filters.taskId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      text,
      phone,
    ],
    filters,
  );
}

export async function findVolunteerApplication(
  applicationId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<VolunteerRow | null> {
  const { rows } = await query<VolunteerRow>(
    `${VOLUNTEER_SELECT} WHERE v.application_id = $1 ${lock ? 'FOR UPDATE OF v' : ''}`,
    [applicationId],
    db,
  );
  return rows[0] ?? null;
}

// --- Assistance requests -------------------------------------------------------------------

export type RequestRow = Reviewer & {
  request_id: number;
  reference_number: string;
  status: string;
  applicant_name: string;
  contact_number: string;
  email: string | null;
  request_type: string;
  description: string;
  submitted_date: Date;
  reviewed_date: Date | null;
  decision_reason: string | null;
};

const REQUEST_SELECT = `SELECT q.request_id, q.reference_number, q.status, q.applicant_name,
    q.contact_number, q.email, q.request_type, q.description, q.submitted_date, q.reviewed_date,
    q.decision_reason, q.reviewed_by, r.full_name AS reviewed_by_name
  FROM assistance_request q
  LEFT JOIN admin_user r ON r.admin_id = q.reviewed_by`;

const REQUEST_SORTS = {
  newest: 'q.submitted_date DESC, q.request_id DESC',
  oldest: 'q.submitted_date ASC, q.request_id ASC',
  name: 'q.applicant_name ASC, q.request_id DESC',
  status: 'q.status ASC, q.submitted_date DESC, q.request_id DESC',
  type: 'q.request_type ASC, q.submitted_date DESC, q.request_id DESC',
};
export const REQUEST_SORT_KEYS = Object.keys(REQUEST_SORTS);

export async function listAssistanceRequests(
  filters: {
    status: string;
    requestType?: string;
    from?: string;
    to?: string;
    search?: string;
    sort?: string;
  } & Page,
): Promise<Listed<RequestRow>> {
  const { text, phone } = searchPatterns(filters.search);
  const where = `($1::text = 'all' OR q.status = $1)
    AND ($2::text IS NULL OR q.request_type = $2)
    AND ${FROM_DAY('q.submitted_date', '$3')}
    AND ${TO_DAY('q.submitted_date', '$4')}
    AND ($5::text IS NULL OR q.applicant_name ILIKE $5 OR q.email ILIKE $5
         OR q.reference_number ILIKE $5 OR ${PHONE_MATCH('q.contact_number', '$6')})`;
  return pageAndCount<RequestRow>(
    REQUEST_SELECT,
    where,
    'FROM assistance_request q',
    pickSort(filters.sort, REQUEST_SORTS, 'newest'),
    [
      filters.status,
      filters.requestType ?? null,
      filters.from ?? null,
      filters.to ?? null,
      text,
      phone,
    ],
    filters,
  );
}

export async function findAssistanceRequest(
  requestId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<RequestRow | null> {
  const { rows } = await query<RequestRow>(
    `${REQUEST_SELECT} WHERE q.request_id = $1 ${lock ? 'FOR UPDATE OF q' : ''}`,
    [requestId],
    db,
  );
  return rows[0] ?? null;
}

/** Opening a submitted request moves it to Under review. True if it moved. */
export async function markRequestUnderReview(
  db: Queryable,
  requestId: number,
  adminId: number,
): Promise<boolean> {
  const { rows } = await query(
    `UPDATE assistance_request
     SET status = 'Under review', reviewed_by = $2, reviewed_date = now()
     WHERE request_id = $1 AND status = 'Submitted'
     RETURNING request_id`,
    [requestId, adminId],
    db,
  );
  return rows.length === 1;
}

// --- Donation pledges ----------------------------------------------------------------------

export type PledgeRow = Reviewer & {
  pledge_id: number;
  reference_number: string;
  status: string;
  donor_name: string;
  email: string;
  contact_number: string;
  category: string;
  description: string;
  /** numeric(10,2) text, e.g. "1200.00" */
  estimated_value: string | null;
  initiative_id: number | null;
  initiative_title: string | null;
  submitted_date: Date;
  reviewed_date: Date | null;
  decision_reason: string | null;
};

const PLEDGE_SELECT = `SELECT p.pledge_id, p.reference_number, p.status, p.donor_name, p.email,
    p.contact_number, p.category, p.description, p.estimated_value::text AS estimated_value,
    p.initiative_id, i.title AS initiative_title, p.submitted_date, p.reviewed_date,
    p.decision_reason, p.reviewed_by, r.full_name AS reviewed_by_name
  FROM donation_pledge p
  LEFT JOIN initiative i ON i.initiative_id = p.initiative_id
  LEFT JOIN admin_user r ON r.admin_id = p.reviewed_by`;

const PLEDGE_SORTS = {
  newest: 'p.submitted_date DESC, p.pledge_id DESC',
  oldest: 'p.submitted_date ASC, p.pledge_id ASC',
  name: 'p.donor_name ASC, p.pledge_id DESC',
  status: 'p.status ASC, p.submitted_date DESC, p.pledge_id DESC',
  value: 'p.estimated_value DESC NULLS LAST, p.pledge_id DESC',
};
export const PLEDGE_SORT_KEYS = Object.keys(PLEDGE_SORTS);

export async function listDonationPledges(
  filters: {
    status: string;
    category?: string;
    initiativeId?: number;
    from?: string;
    to?: string;
    search?: string;
    sort?: string;
  } & Page,
): Promise<Listed<PledgeRow>> {
  const { text, phone } = searchPatterns(filters.search);
  const where = `($1::text = 'all' OR p.status = $1)
    AND ($2::text IS NULL OR p.category = $2)
    AND ($3::int IS NULL OR p.initiative_id = $3)
    AND ${FROM_DAY('p.submitted_date', '$4')}
    AND ${TO_DAY('p.submitted_date', '$5')}
    AND ($6::text IS NULL OR p.donor_name ILIKE $6 OR p.email ILIKE $6
         OR p.reference_number ILIKE $6 OR ${PHONE_MATCH('p.contact_number', '$7')})`;
  return pageAndCount<PledgeRow>(
    PLEDGE_SELECT,
    where,
    'FROM donation_pledge p',
    pickSort(filters.sort, PLEDGE_SORTS, 'newest'),
    [
      filters.status,
      filters.category ?? null,
      filters.initiativeId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      text,
      phone,
    ],
    filters,
  );
}

export async function findDonationPledge(
  pledgeId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<PledgeRow | null> {
  const { rows } = await query<PledgeRow>(
    `${PLEDGE_SELECT} WHERE p.pledge_id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`,
    [pledgeId],
    db,
  );
  return rows[0] ?? null;
}

// --- Saving a decision (the three tables above) --------------------------------------------

const DECISION_TABLES = {
  volunteer: { table: 'volunteer_application', id: 'application_id' },
  request: { table: 'assistance_request', id: 'request_id' },
  pledge: { table: 'donation_pledge', id: 'pledge_id' },
} as const;

/**
 * Sets the new status and who decided, and when. The reason is saved only
 * when one is given (declining); an earlier reason is never wiped.
 */
export async function saveDecision(
  db: Queryable,
  kind: keyof typeof DECISION_TABLES,
  id: number,
  values: { status: string; adminId: number; reason: string | null },
): Promise<void> {
  const { table, id: idColumn } = DECISION_TABLES[kind];
  await query(
    `UPDATE ${table}
     SET status = $2, reviewed_by = $3, reviewed_date = now(),
         decision_reason = COALESCE($4, decision_reason)
     WHERE ${idColumn} = $1`,
    [id, values.status, values.adminId, values.reason],
    db,
  );
}

// --- Enquiries -----------------------------------------------------------------------------

export type EnquiryRow = {
  enquiry_id: number;
  status: string;
  contact_name: string;
  email: string;
  contact_number: string | null;
  enquiry_type: string;
  message: string;
  submitted_date: Date;
};

const ENQUIRY_SELECT = `SELECT e.enquiry_id, e.status, e.contact_name, e.email, e.contact_number,
    e.enquiry_type, e.message, e.submitted_date
  FROM enquiry e`;

const ENQUIRY_SORTS = {
  newest: 'e.submitted_date DESC, e.enquiry_id DESC',
  oldest: 'e.submitted_date ASC, e.enquiry_id ASC',
  name: 'e.contact_name ASC, e.enquiry_id DESC',
  status: 'e.status ASC, e.submitted_date DESC, e.enquiry_id DESC',
};
export const ENQUIRY_SORT_KEYS = Object.keys(ENQUIRY_SORTS);

export async function listEnquiries(
  filters: {
    status: string;
    enquiryType?: string;
    from?: string;
    to?: string;
    search?: string;
    sort?: string;
  } & Page,
): Promise<Listed<EnquiryRow>> {
  const { text, phone } = searchPatterns(filters.search);
  const where = `($1::text = 'all' OR e.status = $1)
    AND ($2::text IS NULL OR e.enquiry_type = $2)
    AND ${FROM_DAY('e.submitted_date', '$3')}
    AND ${TO_DAY('e.submitted_date', '$4')}
    AND ($5::text IS NULL OR e.contact_name ILIKE $5 OR e.email ILIKE $5 OR e.message ILIKE $5
         OR ${PHONE_MATCH('e.contact_number', '$6')})`;
  return pageAndCount<EnquiryRow>(
    ENQUIRY_SELECT,
    where,
    'FROM enquiry e',
    pickSort(filters.sort, ENQUIRY_SORTS, 'newest'),
    [
      filters.status,
      filters.enquiryType ?? null,
      filters.from ?? null,
      filters.to ?? null,
      text,
      phone,
    ],
    filters,
  );
}

export async function findEnquiry(
  enquiryId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<EnquiryRow | null> {
  const { rows } = await query<EnquiryRow>(
    `${ENQUIRY_SELECT} WHERE e.enquiry_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [enquiryId],
    db,
  );
  return rows[0] ?? null;
}

export async function setEnquiryStatus(
  db: Queryable,
  enquiryId: number,
  status: string,
): Promise<void> {
  await query('UPDATE enquiry SET status = $2 WHERE enquiry_id = $1', [enquiryId, status], db);
}
