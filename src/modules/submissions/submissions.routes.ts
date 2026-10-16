import { type RequestHandler, Router } from 'express';
import type { ZodType } from 'zod';
import { honeypot } from '../../middleware/honeypot';
import { limiters } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { ReferencePrefix } from '../../utils/referenceNumber';
import * as controller from './submissions.controller';
import {
  assistanceRequestSchema,
  donationPledgeSchema,
  enquirySchema,
  volunteerApplicationSchema,
} from './submissions.schemas';
import { pretendReceipt } from './submissions.service';

/**
 * The public forms: no sign-in. In order, each POST goes through
 *   1. the limit of 5 forms per IP address per 10 minutes (then 429),
 *   2. the spam trap (a filled-in "website" field gets a pretend success),
 *   3. the form's rules (400 with a message per field),
 *   4. the business rules and saving (201 with the reference number).
 */
function formRouter(
  schema: ZodType,
  prefix: ReferencePrefix | null,
  handler: RequestHandler,
) {
  const router = Router();
  router.post(
    '/',
    limiters.publicForms,
    honeypot(() => pretendReceipt(prefix)),
    validate({ body: schema }),
    handler,
  );
  return router;
}

export const volunteerApplicationsRouter = formRouter(
  volunteerApplicationSchema,
  ReferencePrefix.volunteerApplication,
  controller.volunteer,
);

export const donationPledgesRouter = formRouter(
  donationPledgeSchema,
  ReferencePrefix.donationPledge,
  controller.pledge,
);

export const assistanceRequestsRouter = formRouter(
  assistanceRequestSchema,
  ReferencePrefix.assistanceRequest,
  controller.assistance,
);

export const enquiriesRouter = formRouter(enquirySchema, null, controller.enquiry);

/** GET /form-options */
export const formOptionsRouter = Router();
formOptionsRouter.get('/', controller.options);
