import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { idParam, pagination } from '../../schemas/common';
import * as controller from './stock.controller';
import {
  adjustmentSchema,
  createStockItemSchema,
  fulfilSchema,
  stockListQuery,
  updateStockItemSchema,
} from './stock.schemas';

/** All mounted in routes.ts behind authenticateAdmin (staff and super admins). */

/** /api/v1/admin/stock-items */
export const adminStockItemsRouter = Router();
adminStockItemsRouter.get('/', validate({ query: stockListQuery }), controller.list);
adminStockItemsRouter.post('/', validate({ body: createStockItemSchema }), controller.create);
adminStockItemsRouter.get('/:id', validate({ params: idParam }), controller.get);
adminStockItemsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateStockItemSchema }),
  controller.update,
);
adminStockItemsRouter.get(
  '/:id/movements',
  validate({ params: idParam, query: pagination }),
  controller.movements,
);

/** /api/v1/admin/stock-movements: manual adjustments */
export const adminStockMovementsRouter = Router();
adminStockMovementsRouter.post('/', validate({ body: adjustmentSchema }), controller.adjust);

/** /api/v1/admin/assistance-requests/:id/fulfil (next to the review routes) */
export const adminFulfilmentRouter = Router();
adminFulfilmentRouter.post(
  '/:id/fulfil',
  validate({ params: idParam, body: fulfilSchema }),
  controller.fulfil,
);
