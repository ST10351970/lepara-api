import { Router } from 'express';
import { authenticateCustomer } from '../../middleware/authenticate';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import { noStore } from '../../middleware/trustedOrigin';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import {
  adminOrderListQuery,
  orderPaymentSchema,
  orderStatusSchema,
} from './adminOrders.schemas';
import * as controller from './orders.controller';
import {
  cancelOrderSchema,
  myOrdersQuery,
  orderNumberParams,
  placeOrderSchema,
  quoteSchema,
} from './orders.schemas';

/** /api/v1/cart: prices the bag on the phone. No sign-in needed. */
export const cartRouter = Router();
cartRouter.post('/quote', noStore, validate({ body: quoteSchema }), controller.quote);

/** /api/v1/orders: places an order. A signed-in customer and an Idempotency-Key header. */
export const ordersRouter = Router();
ordersRouter.post(
  '/',
  noStore,
  authenticateCustomer,
  validate({ body: placeOrderSchema }),
  requireIdempotencyKey('POST /orders'),
  controller.place,
);

/** /api/v1/me/orders: the signed-in customer's own orders (the Orders tab). */
export const myOrdersRouter = Router();
myOrdersRouter.use(noStore, authenticateCustomer);
myOrdersRouter.get('/', validate({ query: myOrdersQuery }), controller.listMine);
myOrdersRouter.get('/:orderNumber', validate({ params: orderNumberParams }), controller.getMine);
myOrdersRouter.post(
  '/:orderNumber/cancel',
  validate({ params: orderNumberParams, body: cancelOrderSchema }),
  controller.cancelMine,
);

/**
 * /api/v1/admin/orders: the dashboard. Mounted in routes.ts behind authenticateAdmin
 * (staff and super admins). Replies hold customers' contact details, so they are never cached.
 */
export const adminOrdersRouter = Router();
adminOrdersRouter.use(noStore);
adminOrdersRouter.get('/', validate({ query: adminOrderListQuery }), controller.adminList);
adminOrdersRouter.get('/:id', validate({ params: idParam }), controller.adminGet);
adminOrdersRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: orderStatusSchema }),
  controller.adminChangeStatus,
);
adminOrdersRouter.patch(
  '/:id/payment',
  validate({ params: idParam, body: orderPaymentSchema }),
  controller.adminRecordPayment,
);
