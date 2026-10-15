import { type Queryable, withTransaction } from '../../config/db';
import type { UploadedImage } from '../../middleware/upload';
import { deleteImage, imageStorageReady, saveImage } from '../../services/imageStorage';
import { type FieldError, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { todayInJohannesburg } from '../../utils/dates';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import type { PageMeta } from '../../utils/respond';
import {
  type EventPhase,
  type InitiativeStatus,
  eventPhase,
  formatDateLabel,
  formatTimeLabel,
} from './initiatives.format';
import * as repo from './initiatives.repository';
import type { InitiativeRow, InitiativeValues, TaskRow } from './initiatives.repository';
import {
  type AdminListQuery,
  type CreateInitiativeInput,
  type PublicListQuery,
  type UpdateInitiativeInput,
  dateProblems,
} from './initiatives.schemas';

/**
 * Events (called initiatives in the Task 1 design).
 *
 *  - Drafts are never public. Published and closed events are, as Upcoming
 *    or Completed depending on the date in Johannesburg.
 *  - Status only moves forward: Draft -> Published -> Closed.
 *  - Publishing needs a summary, a location, a start date that hasn't
 *    passed, and at least one task if volunteers are needed.
 *  - A closed event is a record of what happened, so it can't be changed.
 *  - Every change is written to the audit log.
 */

// --- What the app and website receive --------------------------------------------

export type PublicTask = { taskId: number; name: string; volunteersNeeded: number | null };
export type AdminTask = PublicTask & { applicationCount: number };

/** One event card or event page in the app. */
export type PublicEvent = {
  initiativeId: number;
  title: string;
  typeId: number;
  typeName: string;
  summary: string | null;
  description: string;
  location: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  dateLabel: string;
  timeLabel: string | null;
  phase: EventPhase | null;
  imageUrl: string | null;
  donationNeeds: string | null;
  volunteersRequired: boolean;
};

/** What the admin dashboard sees: the same, plus status and counts. */
export type AdminEvent = PublicEvent & {
  status: InitiativeStatus;
  createdAt: Date;
  createdBy: { adminId: number; fullName: string };
  taskCount: number;
  applicationCount: number;
};

function toPublicEvent(row: InitiativeRow, today: string): PublicEvent {
  return {
    initiativeId: row.initiative_id,
    title: row.title,
    typeId: row.type_id,
    typeName: row.type_name,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    dateLabel: formatDateLabel(row.start_date, row.end_date),
    timeLabel: formatTimeLabel(row.start_time, row.end_time),
    phase: eventPhase(row.status, row.end_date, today),
    imageUrl: row.image_url,
    donationNeeds: row.donation_needs,
    volunteersRequired: row.volunteers_required,
  };
}

function toAdminEvent(row: InitiativeRow, today: string): AdminEvent {
  return {
    ...toPublicEvent(row, today),
    status: row.status,
    createdAt: row.created_at,
    createdBy: { adminId: row.created_by, fullName: row.created_by_name },
    taskCount: row.task_count,
    applicationCount: row.application_count,
  };
}

export const toPublicTask = (row: TaskRow): PublicTask => ({
  taskId: row.task_id,
  name: row.task_name,
  volunteersNeeded: row.volunteers_needed,
});

export const toAdminTask = (row: TaskRow): AdminTask => ({
  ...toPublicTask(row),
  applicationCount: row.application_count,
});

const eventNotFound = () => errors.notFound("We couldn't find that event.");
const eventClosed = () => errors.conflict('This event is closed, so it can no longer be changed.');

const audit = (
  db: Queryable,
  adminId: number,
  action: string,
  initiativeId: number,
  details?: Record<string, unknown>,
) => recordAudit({ adminId, action, tableName: 'initiative', recordId: initiativeId, details }, db);

// --- Public ------------------------------------------------------------------------

export async function listPublicEvents(
  filters: PublicListQuery,
  today = todayInJohannesburg(),
): Promise<{ items: PublicEvent[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listPublicInitiatives({
    phase: filters.phase,
    today,
    typeId: filters.typeId,
    limit,
    offset,
  });
  return {
    items: rows.map((row) => toPublicEvent(row, today)),
    meta: pageMeta(filters.page, filters.pageSize, total),
  };
}

/** A public event page, with its volunteer tasks. Drafts answer 404, as if they didn't exist. */
export async function getPublicEvent(
  initiativeId: number,
  today = todayInJohannesburg(),
): Promise<PublicEvent & { tasks: PublicTask[] }> {
  const row = await repo.findInitiative(initiativeId);
  if (!row || row.status === 'Draft') throw eventNotFound();
  const tasks = await repo.listTasks(initiativeId);
  return { ...toPublicEvent(row, today), tasks: tasks.map(toPublicTask) };
}

/** The task picker on the volunteer form. */
export async function getPublicTasks(initiativeId: number): Promise<PublicTask[]> {
  const row = await repo.findInitiative(initiativeId);
  if (!row || row.status === 'Draft') throw eventNotFound();
  return (await repo.listTasks(initiativeId)).map(toPublicTask);
}

// --- Admin: reading ------------------------------------------------------------------

export async function listAdminEvents(
  filters: AdminListQuery,
): Promise<{ items: AdminEvent[]; meta: PageMeta }> {
  const today = todayInJohannesburg();
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listAdminInitiatives({
    status: filters.status,
    search: filters.search,
    typeId: filters.typeId,
    limit,
    offset,
  });
  return {
    items: rows.map((row) => toAdminEvent(row, today)),
    meta: pageMeta(filters.page, filters.pageSize, total),
  };
}

export async function getAdminEvent(
  initiativeId: number,
  db?: Queryable,
): Promise<AdminEvent & { tasks: AdminTask[] }> {
  const row = await repo.findInitiative(initiativeId, db);
  if (!row) throw eventNotFound();
  const tasks = await repo.listTasks(initiativeId, db);
  return { ...toAdminEvent(row, todayInJohannesburg()), tasks: tasks.map(toAdminTask) };
}

// --- Admin: creating and changing -------------------------------------------------------

async function assertTypeExists(typeId: number, db: Queryable): Promise<void> {
  if (!(await repo.findType(typeId, db))) {
    throw errors.validation([
      { field: 'typeId', message: 'Please choose one of the event types.' },
    ]);
  }
}

export async function createEvent(
  adminId: number,
  input: CreateInitiativeInput,
): Promise<AdminEvent & { tasks: AdminTask[] }> {
  return withTransaction(async (client) => {
    await assertTypeExists(input.typeId, client);
    const initiativeId = await repo.insertInitiative(client, adminId, {
      typeId: input.typeId,
      title: input.title,
      summary: input.summary ?? null,
      description: input.description,
      location: input.location ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      donationNeeds: input.donationNeeds ?? null,
      volunteersRequired: input.volunteersRequired,
    });
    await audit(client, adminId, 'initiative_created', initiativeId);
    return getAdminEvent(initiativeId, client);
  });
}

const currentValues = (row: InitiativeRow): InitiativeValues => ({
  typeId: row.type_id,
  title: row.title,
  summary: row.summary,
  description: row.description,
  location: row.location,
  startDate: row.start_date,
  endDate: row.end_date,
  startTime: row.start_time,
  endTime: row.end_time,
  donationNeeds: row.donation_needs,
  volunteersRequired: row.volunteers_required,
});

/** Changes details. Dates are checked together with the values already saved. */
export async function updateEvent(
  adminId: number,
  initiativeId: number,
  input: UpdateInitiativeInput,
): Promise<AdminEvent & { tasks: AdminTask[] }> {
  return withTransaction(async (client) => {
    if (!(await repo.lockInitiative(client, initiativeId))) throw eventNotFound();
    const row = (await repo.findInitiative(initiativeId, client))!;
    if (row.status === 'Closed') throw eventClosed();

    const before = currentValues(row);
    const changes: Partial<InitiativeValues> = {};
    for (const key of Object.keys(before) as Array<keyof InitiativeValues>) {
      const value = input[key];
      if (value !== undefined && value !== before[key]) Object.assign(changes, { [key]: value });
    }
    if (Object.keys(changes).length === 0) return getAdminEvent(initiativeId, client);

    const after = { ...before, ...changes };
    const problems: FieldError[] = dateProblems(after);
    if (row.status === 'Published') {
      if (changes.startDate !== undefined && after.startDate < todayInJohannesburg()) {
        problems.push({
          field: 'startDate',
          message: 'A published event needs a start date of today or later.',
        });
      }
      if (after.volunteersRequired && row.task_count === 0) {
        problems.push({
          field: 'volunteersRequired',
          message: 'Add at least one volunteer task first.',
        });
      }
    }
    if (problems.length > 0) throw errors.validation(problems);
    if (changes.typeId !== undefined) await assertTypeExists(changes.typeId, client);

    await repo.updateInitiative(client, initiativeId, changes);
    await audit(client, adminId, 'initiative_updated', initiativeId, {
      changed: Object.keys(changes),
    });
    return getAdminEvent(initiativeId, client);
  });
}

/** Everything a draft needs before the public can see it. */
function publishProblems(row: InitiativeRow): FieldError[] {
  const problems: FieldError[] = [];
  if (!row.summary) {
    problems.push({ field: 'summary', message: 'Add a short summary for the event card.' });
  }
  if (!row.location) {
    problems.push({ field: 'location', message: 'Add where the event takes place.' });
  }
  if (row.start_date < todayInJohannesburg()) {
    problems.push({
      field: 'startDate',
      message: 'The start date has already passed. Please choose today or a later date.',
    });
  }
  if (row.volunteers_required && row.task_count === 0) {
    problems.push({
      field: 'tasks',
      message: 'Add at least one volunteer task, or say that volunteers are not needed.',
    });
  }
  return problems;
}

const TRANSITION_ERRORS: Record<string, string> = {
  'Published->Draft':
    "A published event can't go back to draft. Close it instead if it's no longer happening.",
  'Closed->Draft': "This event is closed. A closed event can't be moved back to draft.",
  'Closed->Published': "This event is closed. A closed event can't be published again.",
  'Draft->Closed': 'Publish the event before closing it.',
};

/** Draft -> Published -> Closed, and nothing else. */
export async function changeEventStatus(
  adminId: number,
  initiativeId: number,
  status: InitiativeStatus,
): Promise<AdminEvent & { tasks: AdminTask[] }> {
  return withTransaction(async (client) => {
    if (!(await repo.lockInitiative(client, initiativeId))) throw eventNotFound();
    const row = (await repo.findInitiative(initiativeId, client))!;
    if (row.status === status) return getAdminEvent(initiativeId, client);

    const transition = `${row.status}->${status}`;
    const refusal = TRANSITION_ERRORS[transition];
    if (refusal) throw errors.conflict(refusal);

    if (status === 'Published') {
      const problems = publishProblems(row);
      if (problems.length > 0) {
        throw errors.validation(problems, "This event isn't ready to publish yet.");
      }
    }

    await repo.setInitiativeStatus(client, initiativeId, status);
    await audit(
      client,
      adminId,
      status === 'Published' ? 'initiative_published' : 'initiative_closed',
      initiativeId,
    );
    return getAdminEvent(initiativeId, client);
  });
}

/** Saves a new photo for the event, then removes the old one from storage. */
export async function setEventImage(
  adminId: number,
  initiativeId: number,
  image: UploadedImage,
): Promise<AdminEvent & { tasks: AdminTask[] }> {
  if (!imageStorageReady()) {
    throw errors.unavailable('Photo uploads are not set up yet. Please try again later.');
  }
  const existing = await repo.findInitiative(initiativeId);
  if (!existing) throw eventNotFound();
  if (existing.status === 'Closed') throw eventClosed();

  const imageUrl = await saveImage(image, 'initiatives');
  try {
    const { event, previousUrl } = await withTransaction(async (client) => {
      if (!(await repo.lockInitiative(client, initiativeId))) throw eventNotFound();
      const row = (await repo.findInitiative(initiativeId, client))!;
      if (row.status === 'Closed') throw eventClosed();
      await repo.setInitiativeImage(client, initiativeId, imageUrl);
      await audit(client, adminId, 'initiative_image_changed', initiativeId);
      return { event: await getAdminEvent(initiativeId, client), previousUrl: row.image_url };
    });
    await deleteImage(previousUrl);
    return event;
  } catch (error) {
    await deleteImage(imageUrl); // the new photo isn't used after all
    throw error;
  }
}
