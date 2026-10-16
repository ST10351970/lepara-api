import { Router } from 'express';
import { noStore } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './reviews.controller';
import {
  enquiryListQuery,
  enquiryStatusSchema,
  pledgeDecisionSchema,
  pledgeListQuery,
  requestDecisionSchema,
  requestListQuery,
  volunteerDecisionSchema,
  volunteerListQuery,
} from './reviews.schemas';

/**
 * The admin review queues. Mounted in routes.ts behind authenticateAdmin
 * (staff and super admins). Replies hold people's contact details, so they
 * are never cached.
 */

/** /api/v1/admin/volunteer-applications */
export const adminVolunteerApplicationsRouter = Router();
adminVolunteerApplicationsRouter.use(noStore);
adminVolunteerApplicationsRouter.get(
  '/',
  validate({ query: volunteerListQuery }),
  controller.listVolunteers,
);
adminVolunteerApplicationsRouter.get(
  '/:id',
  validate({ params: idParam }),
  controller.getVolunteer,
);
adminVolunteerApplicationsRouter.patch(
  '/:id/decision',
  validate({ params: idParam, body: volunteerDecisionSchema }),
  controller.decideVolunteer,
);

/** /api/v1/admin/assistance-requests */
export const adminAssistanceRequestsRouter = Router();
adminAssistanceRequestsRouter.use(noStore);
adminAssistanceRequestsRouter.get(
  '/',
  validate({ query: requestListQuery }),
  controller.listRequests,
);
adminAssistanceRequestsRouter.get('/:id', validate({ params: idParam }), controller.openRequest);
adminAssistanceRequestsRouter.patch(
  '/:id/decision',
  validate({ params: idParam, body: requestDecisionSchema }),
  controller.decideRequest,
);

/** /api/v1/admin/donation-pledges */
export const adminDonationPledgesRouter = Router();
adminDonationPledgesRouter.use(noStore);
adminDonationPledgesRouter.get('/', validate({ query: pledgeListQuery }), controller.listPledges);
adminDonationPledgesRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: pledgeDecisionSchema }),
  controller.decidePledge,
);

/** /api/v1/admin/enquiries */
export const adminEnquiriesRouter = Router();
adminEnquiriesRouter.use(noStore);
adminEnquiriesRouter.get('/', validate({ query: enquiryListQuery }), controller.listEnquiries);
adminEnquiriesRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: enquiryStatusSchema }),
  controller.setEnquiryStatus,
);
