import { Router } from 'express';
import { noStore } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './adminUsers.controller';
import { createAdminSchema, listAdminsQuery, updateAdminSchema } from './adminUsers.schemas';

/**
 * /api/v1/admin/users: managing admin accounts. Mounted in routes.ts behind
 * authenticateAdmin and requireRole('super_admin'), so staff get 403.
 */
export const adminUsersRouter = Router();

// Replies can hold a temporary password: never cache them.
adminUsersRouter.use(noStore);

adminUsersRouter.get('/', validate({ query: listAdminsQuery }), controller.list);
adminUsersRouter.post('/', validate({ body: createAdminSchema }), controller.create);
adminUsersRouter.get('/:id', validate({ params: idParam }), controller.get);
adminUsersRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateAdminSchema }),
  controller.update,
);
adminUsersRouter.post('/:id/reset-2fa', validate({ params: idParam }), controller.resetTwoFactor);
adminUsersRouter.post(
  '/:id/reset-password',
  validate({ params: idParam }),
  controller.resetPassword,
);
