import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { ok } from '../../utils/respond';
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
import * as service from './reviews.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };

// --- Volunteer applications ---------------------------------------------------------------

/** GET /admin/volunteer-applications */
export async function listVolunteers(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: VolunteerListQuery }>(res);
  const { items, meta } = await service.listVolunteerApplications(query);
  ok(res, items, meta);
}

/** GET /admin/volunteer-applications/:id */
export async function getVolunteer(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getVolunteerApplication(validated<Id>(res).params.id));
}

/** PATCH /admin/volunteer-applications/:id/decision */
export async function decideVolunteer(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: VolunteerDecision }>(res);
  ok(res, await service.decideVolunteerApplication(currentAdmin(res).adminId, params.id, body));
}

// --- Assistance requests ------------------------------------------------------------------

/** GET /admin/assistance-requests */
export async function listRequests(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: RequestListQuery }>(res);
  const { items, meta } = await service.listAssistanceRequests(query);
  ok(res, items, meta);
}

/** GET /admin/assistance-requests/:id: opening a Submitted request moves it to Under review. */
export async function openRequest(_req: Request, res: Response): Promise<void> {
  const { params } = validated<Id>(res);
  ok(res, await service.openAssistanceRequest(currentAdmin(res).adminId, params.id));
}

/** PATCH /admin/assistance-requests/:id/decision */
export async function decideRequest(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: RequestDecision }>(res);
  ok(res, await service.decideAssistanceRequest(currentAdmin(res).adminId, params.id, body));
}

// --- Donation pledges ---------------------------------------------------------------------

/** GET /admin/donation-pledges */
export async function listPledges(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: PledgeListQuery }>(res);
  const { items, meta } = await service.listDonationPledges(query);
  ok(res, items, meta);
}

/** PATCH /admin/donation-pledges/:id/status */
export async function decidePledge(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: PledgeDecision }>(res);
  ok(res, await service.decideDonationPledge(currentAdmin(res).adminId, params.id, body));
}

// --- Enquiries ----------------------------------------------------------------------------

/** GET /admin/enquiries */
export async function listEnquiries(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: EnquiryListQuery }>(res);
  const { items, meta } = await service.listEnquiries(query);
  ok(res, items, meta);
}

/** PATCH /admin/enquiries/:id/status */
export async function setEnquiryStatus(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: EnquiryStatusInput }>(res);
  ok(res, await service.setEnquiryStatus(currentAdmin(res).adminId, params.id, body));
}
