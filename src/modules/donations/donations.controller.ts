import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import type {
  CreateDonationInput,
  DonationListQuery,
  ReceivePledgeInput,
  VoidDonationInput,
} from './donations.schemas';
import * as service from './donations.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };

/** GET /admin/donations */
export async function list(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: DonationListQuery }>(res);
  const { items, meta } = await service.listDonations(query);
  ok(res, items, meta);
}

/** GET /admin/donations/:id */
export async function get(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getDonation(validated<Id>(res).params.id));
}

/** POST /admin/donations */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateDonationInput }>(res);
  created(res, await service.recordDonation(currentAdmin(res).adminId, body));
}

/** POST /admin/donations/:id/void */
export async function voidDonation(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: VoidDonationInput }>(res);
  ok(res, await service.voidDonation(currentAdmin(res).adminId, params.id, body));
}

/** POST /admin/donation-pledges/:id/receive */
export async function receivePledge(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: ReceivePledgeInput }>(res);
  created(res, await service.receivePledge(currentAdmin(res).adminId, params.id, body));
}
