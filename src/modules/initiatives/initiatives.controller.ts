import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { uploadedImage } from '../../middleware/upload';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import type {
  AdminListQuery,
  CreateInitiativeInput,
  CreateTaskInput,
  CreateTypeInput,
  PublicListQuery,
  StatusChangeInput,
  UpdateInitiativeInput,
  UpdateTaskInput,
  UpdateTypeInput,
} from './initiatives.schemas';
import * as events from './initiatives.service';
import * as tasks from './tasks.service';
import * as types from './types.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };
type TaskId = { params: { id: number; taskId: number } };

// --- Public (the app and website, no sign-in) ----------------------------------

/** GET /initiatives */
export async function listPublic(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: PublicListQuery }>(res);
  const { items, meta } = await events.listPublicEvents(query);
  ok(res, items, meta);
}

/** GET /initiatives/:id */
export async function getPublic(_req: Request, res: Response): Promise<void> {
  ok(res, await events.getPublicEvent(validated<Id>(res).params.id));
}

/** GET /initiatives/:id/tasks */
export async function getPublicTasks(_req: Request, res: Response): Promise<void> {
  ok(res, await events.getPublicTasks(validated<Id>(res).params.id));
}

/** GET /initiative-types */
export async function listPublicTypes(_req: Request, res: Response): Promise<void> {
  ok(res, await types.listPublicTypes());
}

// --- Admin: events ----------------------------------------------------------------

/** GET /admin/initiatives */
export async function listAdmin(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: AdminListQuery }>(res);
  const { items, meta } = await events.listAdminEvents(query);
  ok(res, items, meta);
}

/** GET /admin/initiatives/:id */
export async function getAdmin(_req: Request, res: Response): Promise<void> {
  ok(res, await events.getAdminEvent(validated<Id>(res).params.id));
}

/** POST /admin/initiatives: new events start as drafts. */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateInitiativeInput }>(res);
  created(res, await events.createEvent(currentAdmin(res).adminId, body));
}

/** PATCH /admin/initiatives/:id */
export async function update(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateInitiativeInput }>(res);
  ok(res, await events.updateEvent(currentAdmin(res).adminId, params.id, body));
}

/** PATCH /admin/initiatives/:id/status */
export async function changeStatus(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: StatusChangeInput }>(res);
  ok(res, await events.changeEventStatus(currentAdmin(res).adminId, params.id, body.status));
}

/** POST /admin/initiatives/:id/image */
export async function uploadImage(_req: Request, res: Response): Promise<void> {
  const { params } = validated<Id>(res);
  ok(res, await events.setEventImage(currentAdmin(res).adminId, params.id, uploadedImage(res)));
}

// --- Admin: volunteer tasks ------------------------------------------------------------

/** GET /admin/initiatives/:id/tasks */
export async function listTasks(_req: Request, res: Response): Promise<void> {
  ok(res, await tasks.listTasks(validated<Id>(res).params.id));
}

/** POST /admin/initiatives/:id/tasks */
export async function createTask(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: CreateTaskInput }>(res);
  created(res, await tasks.createTask(currentAdmin(res).adminId, params.id, body));
}

/** PATCH /admin/initiatives/:id/tasks/:taskId */
export async function updateTask(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<TaskId & { body: UpdateTaskInput }>(res);
  ok(res, await tasks.updateTask(currentAdmin(res).adminId, params.id, params.taskId, body));
}

/** DELETE /admin/initiatives/:id/tasks/:taskId */
export async function deleteTask(_req: Request, res: Response): Promise<void> {
  const { params } = validated<TaskId>(res);
  await tasks.deleteTask(currentAdmin(res).adminId, params.id, params.taskId);
  ok(res, { deleted: true });
}

// --- Admin: event types ----------------------------------------------------------------

/** GET /admin/initiative-types */
export async function listTypes(_req: Request, res: Response): Promise<void> {
  ok(res, await types.listAdminTypes());
}

/** POST /admin/initiative-types */
export async function createType(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateTypeInput }>(res);
  created(res, await types.createType(currentAdmin(res).adminId, body));
}

/** PATCH /admin/initiative-types/:id */
export async function updateType(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateTypeInput }>(res);
  ok(res, await types.updateType(currentAdmin(res).adminId, params.id, body));
}
