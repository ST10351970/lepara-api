import type { Request, Response } from 'express';
import { currentCustomer } from '../../middleware/authenticate';
import { idempotencyClaim, replay } from '../../middleware/idempotency';
import { validated } from '../../middleware/validate';
import { ok } from '../../utils/respond';
import type {
  CancelOrderInput,
  MyOrdersQuery,
  OrderNumberParams,
  PlaceOrderInput,
  QuoteInput,
} from './orders.schemas';
import * as service from './orders.service';

/** Thin layer: read the request, call the service, send the reply. */

/** POST /cart/quote */
export async function quote(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: QuoteInput }>(res);
  ok(res, await service.quoteCart(body));
}

/** POST /orders (Idempotency-Key header required) */
export async function place(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: PlaceOrderInput }>(res);
  const reply = await service.placeOrder(
    currentCustomer(res).customerId,
    body,
    idempotencyClaim(res),
  );
  if (reply.replayed) {
    replay(res, reply);
    return;
  }
  res.status(reply.status).json({ success: true, data: reply.body });
}

/** GET /me/orders */
export async function listMine(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: MyOrdersQuery }>(res);
  const { orders, meta } = await service.listMyOrders(currentCustomer(res).customerId, query);
  ok(res, orders, meta);
}

/** GET /me/orders/:orderNumber */
export async function getMine(_req: Request, res: Response): Promise<void> {
  const { params } = validated<{ params: OrderNumberParams }>(res);
  ok(res, await service.getMyOrder(currentCustomer(res).customerId, params.orderNumber));
}

/** POST /me/orders/:orderNumber/cancel */
export async function cancelMine(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<{ params: OrderNumberParams; body: CancelOrderInput }>(res);
  ok(
    res,
    await service.cancelMyOrder(currentCustomer(res).customerId, params.orderNumber, body),
  );
}
