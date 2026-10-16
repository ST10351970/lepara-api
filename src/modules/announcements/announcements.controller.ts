import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import type {
  ActiveInput,
  AdminListQuery,
  CreateAnnouncementInput,
  PublicListQuery,
  UpdateAnnouncementInput,
} from './announcements.schemas';
import * as service from './announcements.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };

/** GET /announcements (public) */
export async function listPublic(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: PublicListQuery }>(res);
  const { items, meta } = await service.listPublicAnnouncements(query);
  ok(res, items, meta);
}

/** GET /admin/announcements */
export async function listAdmin(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: AdminListQuery }>(res);
  const { items, meta } = await service.listAdminAnnouncements(query);
  ok(res, items, meta);
}

/** GET /admin/announcements/:id */
export async function getAdmin(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getAdminAnnouncement(validated<Id>(res).params.id));
}

/** POST /admin/announcements: published straight away. */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateAnnouncementInput }>(res);
  created(res, await service.createAnnouncement(currentAdmin(res).adminId, body));
}

/** PATCH /admin/announcements/:id */
export async function update(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateAnnouncementInput }>(res);
  ok(res, await service.updateAnnouncement(currentAdmin(res).adminId, params.id, body));
}

/** PATCH /admin/announcements/:id/active */
export async function setActive(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: ActiveInput }>(res);
  ok(res, await service.setAnnouncementActive(currentAdmin(res).adminId, params.id, body.isActive));
}
