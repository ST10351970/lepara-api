import { type Queryable, withTransaction } from '../../config/db';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { isPgError } from '../../utils/pgErrors';
import * as repo from './initiatives.repository';
import type { CreateTaskInput, UpdateTaskInput } from './initiatives.schemas';
import { type AdminTask, toAdminTask } from './initiatives.service';

/**
 * Volunteer tasks for an event (the Task picker on the volunteer form).
 *  - Names are unique within an event, ignoring capitals.
 *  - A task that already has applications can't be deleted (rename it instead).
 *  - A published event that needs volunteers keeps at least one task.
 *  - A closed event's tasks can't change.
 */

const eventNotFound = () => errors.notFound("We couldn't find that event.");
const taskNotFound = () => errors.notFound("We couldn't find that task.");

function nameTaken(): AppError {
  const message = 'This event already has a task with that name.';
  return new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'name', message }]);
}

const audit = (
  db: Queryable,
  adminId: number,
  action: string,
  taskId: number,
  initiativeId: number,
) =>
  recordAudit(
    { adminId, action, tableName: 'initiative_task', recordId: taskId, details: { initiativeId } },
    db,
  );

/** Locks the event and checks its tasks may change. Returns the event. */
async function openEvent(db: Queryable, initiativeId: number) {
  if (!(await repo.lockInitiative(db, initiativeId))) throw eventNotFound();
  const event = (await repo.findInitiative(initiativeId, db))!;
  if (event.status === 'Closed') {
    throw errors.conflict("This event is closed, so its tasks can't be changed.");
  }
  return event;
}

export async function listTasks(initiativeId: number): Promise<AdminTask[]> {
  if (!(await repo.findInitiative(initiativeId))) throw eventNotFound();
  return (await repo.listTasks(initiativeId)).map(toAdminTask);
}

export async function createTask(
  adminId: number,
  initiativeId: number,
  input: CreateTaskInput,
): Promise<AdminTask> {
  return withTransaction(async (client) => {
    await openEvent(client, initiativeId);
    if (await repo.taskNameTaken(client, initiativeId, input.name, null)) throw nameTaken();
    const taskId = await repo.insertTask(client, initiativeId, {
      name: input.name,
      volunteersNeeded: input.volunteersNeeded ?? null,
    });
    await audit(client, adminId, 'task_created', taskId, initiativeId);
    return toAdminTask((await repo.findTask(client, initiativeId, taskId))!);
  });
}

export async function updateTask(
  adminId: number,
  initiativeId: number,
  taskId: number,
  input: UpdateTaskInput,
): Promise<AdminTask> {
  return withTransaction(async (client) => {
    await openEvent(client, initiativeId);
    const task = await repo.findTask(client, initiativeId, taskId);
    if (!task) throw taskNotFound();
    if (
      input.name !== undefined &&
      (await repo.taskNameTaken(client, initiativeId, input.name, taskId))
    ) {
      throw nameTaken();
    }
    await repo.updateTask(client, taskId, input);
    await audit(client, adminId, 'task_updated', taskId, initiativeId);
    return toAdminTask((await repo.findTask(client, initiativeId, taskId))!);
  });
}

const HAS_APPLICATIONS =
  "This task already has volunteer applications, so it can't be deleted. You can rename it instead.";

export async function deleteTask(
  adminId: number,
  initiativeId: number,
  taskId: number,
): Promise<void> {
  try {
    await withTransaction(async (client) => {
      const event = await openEvent(client, initiativeId);
      const task = await repo.findTask(client, initiativeId, taskId);
      if (!task) throw taskNotFound();
      if (task.application_count > 0) throw errors.conflict(HAS_APPLICATIONS);
      if (event.status === 'Published' && event.volunteers_required && event.task_count <= 1) {
        throw errors.conflict(
          'This published event needs volunteers, so it must keep at least one task.',
        );
      }
      await repo.deleteTask(client, taskId);
      await audit(client, adminId, 'task_deleted', taskId, initiativeId);
    });
  } catch (error) {
    // An application arriving at the same moment: the database refuses the delete.
    if (isPgError(error) && (error.code === '23503' || error.code === '23001')) {
      throw errors.conflict(HAS_APPLICATIONS);
    }
    throw error;
  }
}
