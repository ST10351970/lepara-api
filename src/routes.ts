import { Router } from 'express';
import { authenticateAdmin, requirePasswordChanged } from './middleware/authenticate';
import { requireRole } from './middleware/requireRole';
import { adminAuthRouter, adminMeRouter } from './modules/adminAuth/adminAuth.routes';
import {
  adminAnnouncementsRouter,
  announcementsRouter,
} from './modules/announcements/announcements.routes';
import { adminUsersRouter } from './modules/adminUsers/adminUsers.routes';
import { healthRouter } from './modules/health/health.routes';
import {
  adminInitiativeTypesRouter,
  adminInitiativesRouter,
  initiativeTypesRouter,
  initiativesRouter,
} from './modules/initiatives/initiatives.routes';
import {
  adminProductCategoriesRouter,
  adminProductsRouter,
  productCategoriesRouter,
  productsRouter,
} from './modules/products/products.routes';
import {
  assistanceRequestsRouter,
  donationPledgesRouter,
  enquiriesRouter,
  formOptionsRouter,
  volunteerApplicationsRouter,
} from './modules/submissions/submissions.routes';

/** Everything under /api/v1. Each later step mounts its module here. */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);

// --- Public (the app and the website, no sign-in) ------------------------------

apiRouter.use('/initiatives', initiativesRouter);
apiRouter.use('/initiative-types', initiativeTypesRouter);
apiRouter.use('/announcements', announcementsRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/product-categories', productCategoriesRouter);

// The public forms (5 per IP address per 10 minutes) and their pickers.
apiRouter.use('/form-options', formOptionsRouter);
apiRouter.use('/volunteer-applications', volunteerApplicationsRouter);
apiRouter.use('/donation-pledges', donationPledgesRouter);
apiRouter.use('/assistance-requests', assistanceRequestsRouter);
apiRouter.use('/enquiries', enquiriesRouter);

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
adminRouter.use('/announcements', adminAnnouncementsRouter);
adminRouter.use('/products', adminProductsRouter);
adminRouter.use('/product-categories', adminProductCategoriesRouter);
// Later steps add more admin modules here.

apiRouter.use('/admin', adminRouter);
