import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './donations.controller';
import {
  createDonationSchema,
  donationListQuery,
  receivePledgeSchema,
  voidDonationSchema,
} from './donations.schemas';

/** All mounted in routes.ts behind authenticateAdmin (staff and super admins). */

/** /api/v1/admin/donations */
export const adminDonationsRouter = Router();
adminDonationsRouter.get('/', validate({ query: donationListQuery }), controller.list);
adminDonationsRouter.post('/', validate({ body: createDonationSchema }), controller.create);
adminDonationsRouter.get('/:id', validate({ params: idParam }), controller.get);
adminDonationsRouter.post(
  '/:id/void',
  validate({ params: idParam, body: voidDonationSchema }),
  controller.voidDonation,
);

/** /api/v1/admin/donation-pledges/:id/receive (next to the review routes) */
export const adminPledgeReceiptRouter = Router();
adminPledgeReceiptRouter.post(
  '/:id/receive',
  validate({ params: idParam, body: receivePledgeSchema }),
  controller.receivePledge,
);
