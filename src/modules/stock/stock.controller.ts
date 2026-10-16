import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import type {
  AdjustmentInput,
  CreateStockItemInput,
  FulfilInput,
  StockListQuery,
  UpdateStockItemInput,
} from './stock.schemas';
import * as service from './stock.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };

/** GET /admin/stock-items */
export async function list(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: StockListQuery }>(res);
  const { items, meta } = await service.listStockItems(query);
  ok(res, items, meta);
}

/** GET /admin/stock-items/:id */
export async function get(_req: Request, res: Response): Promise<void> {
  ok(res, await service.getStockItem(validated<Id>(res).params.id));
}

/** POST /admin/stock-items */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateStockItemInput }>(res);
  created(res, await service.createStockItem(currentAdmin(res).adminId, body));
}

/** PATCH /admin/stock-items/:id */
export async function update(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateStockItemInput }>(res);
  ok(res, await service.updateStockItem(currentAdmin(res).adminId, params.id, body));
}

/** GET /admin/stock-items/:id/movements */
export async function movements(_req: Request, res: Response): Promise<void> {
  const { params, query } = validated<Id & { query: { page: number; pageSize: number } }>(res);
  const { items, meta } = await service.listMovements(params.id, query);
  ok(res, items, meta);
}

/** POST /admin/stock-movements */
export async function adjust(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: AdjustmentInput }>(res);
  created(res, await service.adjustStock(currentAdmin(res).adminId, body));
}

/** POST /admin/assistance-requests/:id/fulfil */
export async function fulfil(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: FulfilInput }>(res);
  ok(res, await service.fulfilRequest(currentAdmin(res).adminId, params.id, body));
}
