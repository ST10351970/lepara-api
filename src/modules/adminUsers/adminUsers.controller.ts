import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import type { CreateAdminInput, ListAdminsQuery, UpdateAdminInput } from './adminUsers.schemas';
import * as service from './adminUsers.service';

/** Thin layer: read the request, call the service, send the reply. Super admins only. */

type IdParams = { params: { id: number } };

/** GET /admin/users?status=&search=&page=&pageSize= */
export async function list(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: ListAdminsQuery }>(res);
  const { items, meta } = await service.listAdmins(query);
  ok(res, items, meta);
}

/** GET /admin/users/:id */
export async function get(_req: Request, res: Response): Promise<void> {
  const { params } = validated<IdParams>(res);
  ok(res, await service.getAdmin(params.id));
}

/** POST /admin/users: the temporary password is in this reply only, never again. */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateAdminInput }>(res);
  created(res, await service.createAdmin(currentAdmin(res).adminId, body));
}

/** PATCH /admin/users/:id */
export async function update(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<IdParams & { body: UpdateAdminInput }>(res);
  ok(res, await service.updateAdmin(currentAdmin(res).adminId, params.id, body));
}

/** POST /admin/users/:id/reset-2fa */
export async function resetTwoFactor(_req: Request, res: Response): Promise<void> {
  const { params } = validated<IdParams>(res);
  ok(res, await service.resetTwoFactor(currentAdmin(res).adminId, params.id));
}

/** POST /admin/users/:id/reset-password: the temporary password is in this reply only. */
export async function resetPassword(_req: Request, res: Response): Promise<void> {
  const { params } = validated<IdParams>(res);
  ok(res, await service.resetPassword(currentAdmin(res).adminId, params.id));
}
