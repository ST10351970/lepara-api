import { Router } from 'express';
import { limiters } from '../../middleware/rateLimiters';
import { noStore } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import { trackSubmission } from './tracking.controller';
import { trackSchema } from './tracking.schemas';

/**
 * /api/v1/track: "Track my request". POST, not GET, so the reference number
 * and phone digits never appear in a web address or a server log.
 * 5 wrong attempts per IP address per 15 minutes, then 429.
 */
export const trackingRouter = Router();
trackingRouter.post(
  '/',
  limiters.tracking,
  noStore,
  validate({ body: trackSchema }),
  trackSubmission,
);
