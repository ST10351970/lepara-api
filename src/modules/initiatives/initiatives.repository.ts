import { type Queryable, pool, query } from '../../config/db';
import { likeContains } from '../../utils/sql';
import type { InitiativeStatus } from './initiatives.format';

/**
 * Queries for events (initiatives), their volunteer tasks and their types.
 * Values always go in as $1, $2, ...; column names come only from the fixed
 * lists in this file. Dates are read as YYYY-MM-DD text and times as HH:MM,
 * so no time zone can shift them.
 */

export type InitiativeRow = {
  initiative_id: number;
  type_id: number;
  type_name: string;
  title: string;
  summary: string | null;
  description: string;
  location: string | null;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  donation_needs: string | null;
  volunteers_required: boolean;
  image_url: string | null;
  status: InitiativeStatus;
  created_at: Date;
  created_by: number;
  created_by_name: string;
  task_count: number;
  application_count: number;
};

const INITIATIVE_COLUMNS = `i.initiative_id, i.initiative_type_id AS type_id, t.type_name, i.title,
  i.summary, i.description, i.location,
  i.start_date::text AS start_date, i.end_date::text AS end_date,
  to_char(i.start_time, 'HH24:MI') AS start_time, to_char(i.end_time, 'HH24:MI') AS end_time,
  i.donation_needs, i.volunteers_required, i.image_url, i.status, i.created_at,
  i.created_by, a.full_name AS created_by_name,
  (SELECT count(*)::int FROM initiative_task k WHERE k.initiative_id = i.initiative_id) AS task_count,
  (SELECT count(*)::int FROM volunteer_application v WHERE v.initiative_id = i.initiative_id)
    AS application_count`;

const FROM_INITIATIVES = `FROM initiative i
  JOIN initiative_type t ON t.initiative_type_id = i.initiative_type_id
  JOIN admin_user a ON a.admin_id = i.created_by`;

/** Upcoming means published and not yet over in Johannesburg ($2 is today's date). */
const IS_UPCOMING = `(i.status = 'Published' AND i.end_date >= $2::date)`;

// --- Public lists ----------------------------------------------------------------

/** Published and closed events only: drafts are never public. Upcoming first (soonest first), then completed (latest first). */
export async function listPublicInitiatives(filters: {
  phase: 'upcoming' | 'completed' | 'all';
  today: string;
  typeId: number | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: InitiativeRow[]; total: number }> {
  const where = `i.status <> 'Draft'
    AND ($1::text = 'all' OR ($1::text = 'upcoming') = ${IS_UPCOMING})
    AND ($3::int IS NULL OR i.initiative_type_id = $3)`;
  const values = [filters.phase, filters.today, filters.typeId ?? null];
  const [page, count] = await Promise.all([
    query<InitiativeRow>(
      `SELECT ${INITIATIVE_COLUMNS} ${FROM_INITIATIVES}
       WHERE ${where}
       ORDER BY ${IS_UPCOMING} DESC,
                CASE WHEN ${IS_UPCOMING} THEN i.start_date END ASC,
                i.end_date DESC, i.initiative_id DESC
       LIMIT $4 OFFSET $5`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM initiative i WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function listAdminInitiatives(filters: {
  status: InitiativeStatus | 'all';
  search: string | undefined;
  typeId: number | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: InitiativeRow[]; total: number }> {
  const where = `($1::text = 'all' OR i.status = $1)
    AND ($2::text IS NULL OR i.title ILIKE $2 OR i.location ILIKE $2)
    AND ($3::int IS NULL OR i.initiative_type_id = $3)`;
  const values = [
    filters.status,
    filters.search ? likeContains(filters.search) : null,
    filters.typeId ?? null,
  ];
  const [page, count] = await Promise.all([
    query<InitiativeRow>(
      `SELECT ${INITIATIVE_COLUMNS} ${FROM_INITIATIVES}
       WHERE ${where}
       ORDER BY i.start_date DESC, i.initiative_id DESC
       LIMIT $4 OFFSET $5`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM initiative i WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

// --- One initiative ------------------------------------------------------------------

export async function findInitiative(
  initiativeId: number,
  db: Queryable = pool,
): Promise<InitiativeRow | null> {
  const { rows } = await query<InitiativeRow>(
    `SELECT ${INITIATIVE_COLUMNS} ${FROM_INITIATIVES} WHERE i.initiative_id = $1`,
    [initiativeId],
    db,
  );
  return rows[0] ?? null;
}

/** Locks the event's row until the transaction ends, so two changes can't overlap. */
export async function lockInitiative(db: Queryable, initiativeId: number): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM initiative WHERE initiative_id = $1 FOR UPDATE',
    [initiativeId],
    db,
  );
  return rows.length === 1;
}

export type InitiativeValues = {
  typeId: number;
  title: string;
  summary: string | null;
  description: string;
  location: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  donationNeeds: string | null;
  volunteersRequired: boolean;
};

const COLUMNS: Record<keyof InitiativeValues, string> = {
  typeId: 'initiative_type_id',
  title: 'title',
  summary: 'summary',
  description: 'description',
  location: 'location',
  startDate: 'start_date',
  endDate: 'end_date',
  startTime: 'start_time',
  endTime: 'end_time',
  donationNeeds: 'donation_needs',
  volunteersRequired: 'volunteers_required',
};

/** A new event, always a draft. Returns its ID. */
export async function insertInitiative(
  db: Queryable,
  createdBy: number,
  values: InitiativeValues,
): Promise<number> {
  const keys = Object.keys(COLUMNS) as Array<keyof InitiativeValues>;
  const columns = keys.map((key) => COLUMNS[key]);
  const placeholders = keys.map((_key, index) => `$${index + 3}`);
  const { rows } = await query<{ initiative_id: number }>(
    `INSERT INTO initiative (created_by, status, ${columns.join(', ')})
     VALUES ($1, $2, ${placeholders.join(', ')})
     RETURNING initiative_id`,
    [createdBy, 'Draft', ...keys.map((key) => values[key])],
    db,
  );
  return rows[0]!.initiative_id;
}

/** Saves only the fields given. */
export async function updateInitiative(
  db: Queryable,
  initiativeId: number,
  changes: Partial<InitiativeValues>,
): Promise<void> {
  const values: unknown[] = [initiativeId];
  const assignments: string[] = [];
  for (const key of Object.keys(COLUMNS) as Array<keyof InitiativeValues>) {
    if (changes[key] === undefined) continue;
    values.push(changes[key]);
    assignments.push(`${COLUMNS[key]} = $${values.length}`);
  }
  if (assignments.length === 0) return;
  await query(
    `UPDATE initiative SET ${assignments.join(', ')} WHERE initiative_id = $1`,
    values,
    db,
  );
}

export async function setInitiativeStatus(
  db: Queryable,
  initiativeId: number,
  status: InitiativeStatus,
): Promise<void> {
  await query(
    'UPDATE initiative SET status = $2 WHERE initiative_id = $1',
    [initiativeId, status],
    db,
  );
}

export async function setInitiativeImage(
  db: Queryable,
  initiativeId: number,
  imageUrl: string,
): Promise<void> {
  await query(
    'UPDATE initiative SET image_url = $2 WHERE initiative_id = $1',
    [initiativeId, imageUrl],
    db,
  );
}

// --- Volunteer tasks ---------------------------------------------------------------------

export type TaskRow = {
  task_id: number;
  initiative_id: number;
  task_name: string;
  volunteers_needed: number | null;
  application_count: number;
};

const TASK_COLUMNS = `k.initiative_task_id AS task_id, k.initiative_id, k.task_name, k.volunteers_needed,
  (SELECT count(*)::int FROM volunteer_application v WHERE v.initiative_task_id = k.initiative_task_id)
    AS application_count`;

export async function listTasks(initiativeId: number, db: Queryable = pool): Promise<TaskRow[]> {
  const { rows } = await query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM initiative_task k
     WHERE k.initiative_id = $1
     ORDER BY k.initiative_task_id`,
    [initiativeId],
    db,
  );
  return rows;
}

export async function findTask(
  db: Queryable,
  initiativeId: number,
  taskId: number,
): Promise<TaskRow | null> {
  const { rows } = await query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM initiative_task k
     WHERE k.initiative_id = $1 AND k.initiative_task_id = $2`,
    [initiativeId, taskId],
    db,
  );
  return rows[0] ?? null;
}

/** True if another task on the same event already has this name (capitals ignored). */
export async function taskNameTaken(
  db: Queryable,
  initiativeId: number,
  name: string,
  exceptTaskId: number | null,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM initiative_task
     WHERE initiative_id = $1 AND lower(task_name) = lower($2)
       AND ($3::int IS NULL OR initiative_task_id <> $3)`,
    [initiativeId, name, exceptTaskId],
    db,
  );
  return rows.length > 0;
}

export async function insertTask(
  db: Queryable,
  initiativeId: number,
  task: { name: string; volunteersNeeded: number | null },
): Promise<number> {
  const { rows } = await query<{ task_id: number }>(
    `INSERT INTO initiative_task (initiative_id, task_name, volunteers_needed)
     VALUES ($1, $2, $3) RETURNING initiative_task_id AS task_id`,
    [initiativeId, task.name, task.volunteersNeeded],
    db,
  );
  return rows[0]!.task_id;
}

export async function updateTask(
  db: Queryable,
  taskId: number,
  changes: { name?: string; volunteersNeeded?: number | null },
): Promise<void> {
  await query(
    `UPDATE initiative_task
     SET task_name = CASE WHEN $2::boolean THEN $3 ELSE task_name END,
         volunteers_needed = CASE WHEN $4::boolean THEN $5::int ELSE volunteers_needed END
     WHERE initiative_task_id = $1`,
    [
      taskId,
      changes.name !== undefined,
      changes.name ?? null,
      changes.volunteersNeeded !== undefined,
      changes.volunteersNeeded ?? null,
    ],
    db,
  );
}

export async function deleteTask(db: Queryable, taskId: number): Promise<void> {
  await query('DELETE FROM initiative_task WHERE initiative_task_id = $1', [taskId], db);
}

// --- Event types --------------------------------------------------------------------------

export type TypeRow = {
  type_id: number;
  type_name: string;
  description: string | null;
  initiative_count: number;
};

const TYPE_COLUMNS = `t.initiative_type_id AS type_id, t.type_name, t.description,
  (SELECT count(*)::int FROM initiative i WHERE i.initiative_type_id = t.initiative_type_id)
    AS initiative_count`;

export async function listTypes(): Promise<TypeRow[]> {
  const { rows } = await query<TypeRow>(
    `SELECT ${TYPE_COLUMNS} FROM initiative_type t ORDER BY t.type_name`,
  );
  return rows;
}

export async function findType(typeId: number, db: Queryable = pool): Promise<TypeRow | null> {
  const { rows } = await query<TypeRow>(
    `SELECT ${TYPE_COLUMNS} FROM initiative_type t WHERE t.initiative_type_id = $1`,
    [typeId],
    db,
  );
  return rows[0] ?? null;
}

/** True if another type already has this name (capitals ignored). */
export async function typeNameTaken(
  db: Queryable,
  name: string,
  exceptTypeId: number | null,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM initiative_type
     WHERE lower(type_name) = lower($1) AND ($2::int IS NULL OR initiative_type_id <> $2)`,
    [name, exceptTypeId],
    db,
  );
  return rows.length > 0;
}

export async function insertType(
  db: Queryable,
  type: { name: string; description: string | null },
): Promise<number> {
  const { rows } = await query<{ type_id: number }>(
    `INSERT INTO initiative_type (type_name, description) VALUES ($1, $2)
     RETURNING initiative_type_id AS type_id`,
    [type.name, type.description],
    db,
  );
  return rows[0]!.type_id;
}

export async function updateType(
  db: Queryable,
  typeId: number,
  changes: { name?: string; description?: string | null },
): Promise<void> {
  await query(
    `UPDATE initiative_type
     SET type_name = CASE WHEN $2::boolean THEN $3 ELSE type_name END,
         description = CASE WHEN $4::boolean THEN $5 ELSE description END
     WHERE initiative_type_id = $1`,
    [
      typeId,
      changes.name !== undefined,
      changes.name ?? null,
      changes.description !== undefined,
      changes.description ?? null,
    ],
    db,
  );
}
