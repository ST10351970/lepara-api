import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { limiters } from '../../middleware/rateLimiters';
import { noStore, requireTrustedOrigin } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import * as controller from './adminAuth.controller';
import {
  changePasswordSchema,
  confirmTwoFactorSchema,
  loginSchema,
  signInTokenSchema,
  verifyTwoFactorSchema,
} from './adminAuth.schemas';

/** /api/v1/admin/auth: signing in and out. Open to anyone, protected by rate limits. */
export const adminAuthRouter = Router();

adminAuthRouter.use(noStore, requireTrustedOrigin);

adminAuthRouter.post('/login', limiters.login, validate({ body: loginSchema }), controller.login);
adminAuthRouter.post(
  '/2fa/setup',
  limiters.codeEntry,
  validate({ body: signInTokenSchema }),
  controller.startTwoFactorSetup,
);
adminAuthRouter.post(
  '/2fa/confirm',
  limiters.codeEntry,
  validate({ body: confirmTwoFactorSchema }),
  controller.confirmTwoFactorSetup,
);
adminAuthRouter.post(
  '/2fa/verify',
  limiters.codeEntry,
  validate({ body: verifyTwoFactorSchema }),
  controller.verifyTwoFactor,
);
adminAuthRouter.post('/refresh', controller.refresh);
adminAuthRouter.post('/logout', controller.logout);
adminAuthRouter.post('/logout-all', authenticateAdmin, controller.logoutEverywhere);

/** /api/v1/admin/me: the signed-in admin's own account. Mounted behind authenticateAdmin. */
export const adminMeRouter = Router();

adminMeRouter.use(noStore);

adminMeRouter.get('/', controller.me);
adminMeRouter.patch(
  '/password',
  limiters.login,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
