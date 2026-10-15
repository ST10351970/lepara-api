import { Router } from 'express';
import { authenticateAdmin, requirePasswordChanged } from './middleware/authenticate';
import { requireRole } from './middleware/requireRole';
import { adminAuthRouter, adminMeRouter } from './modules/adminAuth/adminAuth.routes';
import { adminUsersRouter } from './modules/adminUsers/adminUsers.routes';
import { healthRouter } from './modules/health/health.routes';

/** Everything under /api/v1. Each later step mounts its module here. */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);

// --- Admin (website only) ------------------------------------------------------

// Signing in and out: open to anyone.
apiRouter.use('/admin/auth', adminAuthRouter);

// Everything else under /admin needs a signed-in admin.
const adminRouter = Router();
adminRouter.use(authenticateAdmin);
adminRouter.use('/me', adminMeRouter);
// Below this line, a temporary password must have been changed first.
adminRouter.use(requirePasswordChanged);
adminRouter.use('/users', requireRole('super_admin'), adminUsersRouter);
// Later steps add the admin modules here, for example:
//   adminRouter.use('/initiatives', adminInitiativesRouter);

apiRouter.use('/admin', adminRouter);
