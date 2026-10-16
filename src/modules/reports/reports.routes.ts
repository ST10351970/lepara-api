import { Router } from 'express';
import { noStore } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './reports.controller';
import { donationReportQuery, formatQuery, rangeQuery } from './reports.schemas';

/**
 * The dashboard and reports. Mounted in routes.ts behind authenticateAdmin
 * (staff and super admins). Never cached: the numbers change all the time and
 * the CSV files hold people's names.
 */

/** /api/v1/admin/dashboard */
export const adminDashboardRouter = Router();
adminDashboardRouter.get('/', noStore, controller.dashboard);

/** /api/v1/admin/reports */
export const adminReportsRouter = Router();
adminReportsRouter.use(noStore);
adminReportsRouter.get(
  '/donations',
  validate({ query: donationReportQuery }),
  controller.donations,
);
adminReportsRouter.get('/stock', validate({ query: rangeQuery }), controller.stock);
adminReportsRouter.get(
  '/assistance-requests',
  validate({ query: rangeQuery }),
  controller.assistanceRequests,
);
adminReportsRouter.get('/initiatives', validate({ query: rangeQuery }), controller.initiatives);
adminReportsRouter.get(
  '/initiatives/:id',
  validate({ params: idParam, query: formatQuery }),
  controller.initiative,
);
adminReportsRouter.get('/sales', validate({ query: rangeQuery }), controller.sales);
