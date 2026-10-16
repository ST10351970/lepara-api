import { Router } from 'express';
import { authenticateCustomer } from '../../middleware/authenticate';
import { limiters } from '../../middleware/rateLimiters';
import { noStore, requireTrustedOrigin } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import * as controller from './customerAuth.controller';
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  loginVerifySchema,
  registerSchema,
  resendCodeSchema,
  resetPasswordSchema,
  twoFactorSchema,
  updateProfileSchema,
  verifyEmailSchema,
  verifyNewEmailSchema,
} from './customerAuth.schemas';

/** /api/v1/auth: customer sign-up and sign-in. Open to anyone, protected by rate limits. */
export const customerAuthRouter = Router();

customerAuthRouter.use(noStore, requireTrustedOrigin);

customerAuthRouter.post(
  '/register',
  limiters.login,
  validate({ body: registerSchema }),
  controller.register,
);
customerAuthRouter.post(
  '/verify-email',
  limiters.codeEntry,
  validate({ body: verifyEmailSchema }),
  controller.verifyEmail,
);
customerAuthRouter.post(
  '/resend-code',
  limiters.codeEntry,
  validate({ body: resendCodeSchema }),
  controller.resendCode,
);
customerAuthRouter.post('/login', limiters.login, validate({ body: loginSchema }), controller.login);
customerAuthRouter.post(
  '/login/verify',
  limiters.codeEntry,
  validate({ body: loginVerifySchema }),
  controller.verifyLogin,
);
customerAuthRouter.post('/refresh', controller.refresh);
customerAuthRouter.post('/logout', controller.logout);
customerAuthRouter.post(
  '/forgot-password',
  limiters.login,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
customerAuthRouter.post(
  '/reset-password',
  limiters.codeEntry,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

/** /api/v1/me: the signed-in customer's own account. */
export const customerMeRouter = Router();

customerMeRouter.use(noStore, authenticateCustomer);

customerMeRouter.get('/', controller.me);
customerMeRouter.patch('/', validate({ body: updateProfileSchema }), controller.updateMe);
customerMeRouter.post(
  '/email/verify',
  limiters.codeEntry,
  validate({ body: verifyNewEmailSchema }),
  controller.verifyNewEmail,
);
customerMeRouter.patch(
  '/password',
  limiters.login,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
customerMeRouter.patch(
  '/two-factor',
  limiters.login,
  validate({ body: twoFactorSchema }),
  controller.setTwoFactor,
);
customerMeRouter.delete(
  '/',
  limiters.login,
  validate({ body: deleteAccountSchema }),
  controller.deleteMe,
);
