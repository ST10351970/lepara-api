import type { Request, Response } from 'express';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import { FORM_OPTIONS } from './submissions.options';
import type {
  AssistanceRequestInput,
  DonationPledgeInput,
  EnquiryInput,
  VolunteerApplicationInput,
} from './submissions.schemas';
import * as service from './submissions.service';

/** Thin layer: read the request, call the service, send the reply. */

/** GET /form-options: the choices for the forms' pickers. */
export function options(_req: Request, res: Response): void {
  ok(res, FORM_OPTIONS);
}

/** POST /volunteer-applications */
export async function volunteer(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: VolunteerApplicationInput }>(res);
  created(res, await service.submitVolunteerApplication(body));
}

/** POST /donation-pledges */
export async function pledge(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: DonationPledgeInput }>(res);
  created(res, await service.submitDonationPledge(body));
}

/** POST /assistance-requests */
export async function assistance(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: AssistanceRequestInput }>(res);
  created(res, await service.submitAssistanceRequest(body));
}

/** POST /enquiries */
export async function enquiry(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: EnquiryInput }>(res);
  created(res, await service.submitEnquiry(body));
}
