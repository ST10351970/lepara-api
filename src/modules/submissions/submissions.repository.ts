import { type Queryable, pool, query } from '../../config/db';
import type { InitiativeStatus } from '../initiatives/initiatives.format';

/**
 * Saving the public forms. Values always go in as $1, $2, ...
 * consent_given_at is the moment the server received the ticked box.
 */

export type EventForForm = {
  initiative_id: number;
  title: string;
  status: InitiativeStatus;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  volunteers_required: boolean;
};

/**
 * Reads the event and holds a shared lock on it until the transaction ends,
 * so an admin can't close or unpublish it halfway through a submission.
 */
export async function lockEventForForm(
  db: Queryable,
  initiativeId: number,
): Promise<EventForForm | null> {
  const { rows } = await query<EventForForm>(
    `SELECT initiative_id, title, status,
            start_date::text AS start_date, end_date::text AS end_date,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            location, volunteers_required
     FROM initiative
     WHERE initiative_id = $1
     FOR SHARE`,
    [initiativeId],
    db,
  );
  return rows[0] ?? null;
}

export type TaskChoice = { task_id: number; task_name: string };

export async function listEventTasks(db: Queryable, initiativeId: number): Promise<TaskChoice[]> {
  const { rows } = await query<TaskChoice>(
    `SELECT initiative_task_id AS task_id, task_name
     FROM initiative_task
     WHERE initiative_id = $1
     ORDER BY initiative_task_id`,
    [initiativeId],
    db,
  );
  return rows;
}

type Saved = { submitted_date: Date };

export async function insertVolunteerApplication(
  db: Queryable,
  values: {
    referenceNumber: string;
    initiativeId: number;
    taskId: number | null;
    name: string;
    phone: string;
    email: string | null;
    contribution: string;
    availability: string;
  },
): Promise<Saved> {
  const { rows } = await query<Saved>(
    `INSERT INTO volunteer_application
       (reference_number, initiative_id, initiative_task_id, applicant_name, contact_number,
        email, contribution_description, availability_note, status, consent_given_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Submitted', now())
     RETURNING submitted_date`,
    [
      values.referenceNumber,
      values.initiativeId,
      values.taskId,
      values.name,
      values.phone,
      values.email,
      values.contribution,
      values.availability,
    ],
    db,
  );
  return rows[0]!;
}

export async function insertDonationPledge(
  db: Queryable,
  values: {
    referenceNumber: string;
    initiativeId: number | null;
    name: string;
    email: string;
    phone: string;
    category: string;
    description: string;
    /** numeric(10,2) text, e.g. "1200.00" */
    estimatedValue: string | null;
  },
): Promise<Saved & { status: string }> {
  const { rows } = await query<Saved & { status: string }>(
    `INSERT INTO donation_pledge
       (reference_number, initiative_id, donor_name, email, contact_number, category,
        description, estimated_value, consent_given_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING submitted_date, status`,
    [
      values.referenceNumber,
      values.initiativeId,
      values.name,
      values.email,
      values.phone,
      values.category,
      values.description,
      values.estimatedValue,
    ],
    db,
  );
  return rows[0]!;
}

export async function insertAssistanceRequest(
  values: {
    referenceNumber: string;
    name: string;
    phone: string;
    email: string | null;
    requestType: string;
    description: string;
  },
  db: Queryable = pool,
): Promise<Saved> {
  const { rows } = await query<Saved>(
    `INSERT INTO assistance_request
       (reference_number, applicant_name, contact_number, email, request_type, description,
        status, consent_given_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Submitted', now())
     RETURNING submitted_date`,
    [
      values.referenceNumber,
      values.name,
      values.phone,
      values.email,
      values.requestType,
      values.description,
    ],
    db,
  );
  return rows[0]!;
}

export async function insertEnquiry(
  values: {
    name: string;
    phone: string | null;
    email: string;
    enquiryType: string;
    message: string;
  },
  db: Queryable = pool,
): Promise<Saved> {
  const { rows } = await query<Saved>(
    `INSERT INTO enquiry (contact_name, contact_number, email, enquiry_type, message, status,
                          consent_given_at)
     VALUES ($1, $2, $3, $4, $5, 'New', now())
     RETURNING submitted_date`,
    [values.name, values.phone, values.email, values.enquiryType, values.message],
    db,
  );
  return rows[0]!;
}
