import { Router } from 'express';
import { authenticateAdmin, requirePasswordChanged } from './middleware/authenticate';
import { requireRole } from './middleware/requireRole';
import { adminAuthRouter, adminMeRouter } from './modules/adminAuth/adminAuth.routes';
import { adminUsersRouter } from './modules/adminUsers/adminUsers.routes';
import { healthRouter } from './modules/health/health.routes';
import {
  adminInitiativeTypesRouter,
  adminInitiativesRouter,
  initiativeTypesRouter,
  initiativesRouter,
} from './modules/initiatives/initiatives.routes';

/** Everything under /api/v1. Each later step mounts its module here. */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);

// --- Public (the app and the website, no sign-in) ------------------------------

apiRouter.use('/initiatives', initiativesRouter);
apiRouter.use('/initiative-types', initiativeTypesRouter);

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
adminRouter.use('/initiatives', adminInitiativesRouter);
adminRouter.use('/initiative-types', adminInitiativeTypesRouter);
// Later steps add more admin modules here.

apiRouter.use('/admin', adminRouter);
