import { withTransaction } from '../../config/db';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import { constraintOf } from '../../utils/pgErrors';
import type { PageMeta } from '../../utils/respond';
import { findAssistanceRequest, saveDecision } from '../reviews/reviews.repository';
import { type RequestItem, toRequestItem } from '../reviews/reviews.service';
import { canMove, refusalMessage } from '../reviews/reviews.transitions';
import * as repo from './stock.repository';
import type { MovementRow, StockItemRow } from './stock.repository';
import type {
  AdjustmentInput,
  CreateStockItemInput,
  FulfilInput,
  StockListQuery,
  UpdateStockItemInput,
} from './stock.schemas';

/**
 * Stock: the goods the organisation collects and hands out (blankets, food
 * parcels, ...). Every change runs in one transaction that locks the stock
 * rows it touches (SELECT ... FOR UPDATE), so two admins can never give out
 * the same last blanket twice, and every change is a stock_movement row, so
 * the history always adds up to the quantity on hand.
 */

export type StockItem = {
  stockItemId: number;
  name: string;
  category: string | null;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number;
  /** At or below the reorder level: the dashboard's low-stock warning. */
  isLow: boolean;
};

export function toStockItem(row: StockItemRow): StockItem {
  return {
    stockItemId: row.stock_item_id,
    name: row.item_name,
    category: row.category,
    unit: row.unit_of_measure,
    quantityOnHand: row.quantity_on_hand,
    reorderLevel: row.reorder_level,
    isLow: row.quantity_on_hand <= row.reorder_level,
  };
}

export const stockItemNotFound = () => errors.notFound("We couldn't find that stock item.");

const nameTaken = () =>
  new AppError(409, ErrorCode.CONFLICT, 'There is already a stock item with that name.', [
    { field: 'name', message: 'There is already a stock item with that name.' },
  ]);

/** "12 blankets", "1 blanket": units are stored singular, as in the seed data. */
export function amountOf(quantity: number, unit: string): string {
  return `${quantity} ${quantity === 1 || unit.endsWith('s') ? unit : `${unit}s`}`;
}

/** 409 when there isn't enough of an item, naming it and saying how many are left. */
export function shortStock(item: StockItemRow, wanted: number, field?: string): AppError {
  const message =
    `Not enough ${item.item_name} in stock: ${amountOf(wanted, item.unit_of_measure)} ` +
    `needed, but only ${item.quantity_on_hand} left.`;
  return new AppError(409, ErrorCode.CONFLICT, message, field ? [{ field, message }] : undefined);
}

// --- Stock items ---------------------------------------------------------------------------

export async function listStockItems(
  filters: StockListQuery,
): Promise<{ items: StockItem[]; meta: PageMeta }> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listStockItems({ ...filters, ...page });
  return { items: rows.map(toStockItem), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function getStockItem(stockItemId: number): Promise<StockItem> {
  const row = await repo.findStockItem(stockItemId);
  if (!row) throw stockItemNotFound();
  return toStockItem(row);
}

export async function createStockItem(
  adminId: number,
  input: CreateStockItemInput,
): Promise<StockItem> {
  try {
    return await withTransaction(async (client) => {
      if (await repo.itemNameTaken(client, input.name, null)) throw nameTaken();
      const stockItemId = await repo.insertStockItem(client, {
        name: input.name,
        category: input.category ?? null,
        unit: input.unit,
        reorderLevel: input.reorderLevel,
      });
      if (input.openingQuantity > 0) {
        await repo.recordMovement(client, {
          stockItemId,
          type: 'Increase',
          quantity: input.openingQuantity,
          adminId,
          reason: 'Opening stock',
        });
      }
      await recordAudit(
        {
          adminId,
          action: 'stock_item_created',
          tableName: 'stock_item',
          recordId: stockItemId,
          details: { openingQuantity: input.openingQuantity },
        },
        client,
      );
      return toStockItem((await repo.findStockItem(stockItemId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'stock_item_item_name_key') throw nameTaken();
    throw error;
  }
}

export async function updateStockItem(
  adminId: number,
  stockItemId: number,
  input: UpdateStockItemInput,
): Promise<StockItem> {
  try {
    return await withTransaction(async (client) => {
      const current = (await repo.lockStockItems(client, [stockItemId])).get(stockItemId);
      if (!current) throw stockItemNotFound();

      const changes: repo.StockItemChanges = {};
      if (input.name !== undefined && input.name !== current.item_name) {
        if (await repo.itemNameTaken(client, input.name, stockItemId)) throw nameTaken();
        changes.item_name = input.name;
      }
      if (input.category !== undefined && input.category !== current.category) {
        changes.category = input.category;
      }
      if (input.unit !== undefined && input.unit !== current.unit_of_measure) {
        changes.unit_of_measure = input.unit;
      }
      if (input.reorderLevel !== undefined && input.reorderLevel !== current.reorder_level) {
        changes.reorder_level = input.reorderLevel;
      }
      if (Object.keys(changes).length === 0) return toStockItem(current);

      await repo.updateStockItem(client, stockItemId, changes);
      await recordAudit(
        {
          adminId,
          action: 'stock_item_updated',
          tableName: 'stock_item',
          recordId: stockItemId,
          details: { changed: Object.keys(changes) },
        },
        client,
      );
      return toStockItem((await repo.findStockItem(stockItemId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'stock_item_item_name_key') throw nameTaken();
    throw error;
  }
}

// --- Movement history ----------------------------------------------------------------------

export type Movement = {
  movementId: number;
  type: 'Increase' | 'Decrease';
  quantity: number;
  date: Date;
  reason: string | null;
  /** Where it came from: a donation, an assistance request, or a manual adjustment. */
  source:
    | { kind: 'donation'; donationId: number; donorName: string }
    | { kind: 'request'; requestId: number; referenceNumber: string }
    | { kind: 'adjustment' };
  recordedBy: { adminId: number; fullName: string };
};

function toMovement(row: MovementRow): Movement {
  const source: Movement['source'] =
    row.donation_id !== null
      ? {
          kind: 'donation',
          donationId: row.donation_id,
          donorName: row.donation_is_anonymous ? 'Anonymous' : (row.donor_name ?? ''),
        }
      : row.request_id !== null
        ? { kind: 'request', requestId: row.request_id, referenceNumber: row.request_reference! }
        : { kind: 'adjustment' };
  return {
    movementId: row.movement_id,
    type: row.movement_type,
    quantity: row.quantity,
    date: row.movement_date,
    reason: row.reason,
    source,
    recordedBy: { adminId: row.recorded_by, fullName: row.recorded_by_name },
  };
}

export async function listMovements(
  stockItemId: number,
  paging: { page: number; pageSize: number },
): Promise<{ items: Movement[]; meta: PageMeta }> {
  if (!(await repo.findStockItem(stockItemId))) throw stockItemNotFound();
  const { rows, total } = await repo.listMovements(
    stockItemId,
    pageToLimitOffset(paging.page, paging.pageSize),
  );
  return { items: rows.map(toMovement), meta: pageMeta(paging.page, paging.pageSize, total) };
}

// --- Manual adjustments --------------------------------------------------------------------

/** A correction by hand: damaged or expired goods, a recount. Never below zero. */
export async function adjustStock(adminId: number, input: AdjustmentInput): Promise<StockItem> {
  return withTransaction(async (client) => {
    const item = (await repo.lockStockItems(client, [input.stockItemId])).get(input.stockItemId);
    if (!item) {
      throw errors.validation([{ field: 'stockItemId', message: 'Please choose a stock item.' }]);
    }
    if (input.type === 'Decrease' && input.quantity > item.quantity_on_hand) {
      throw shortStock(item, input.quantity, 'quantity');
    }
    await repo.recordMovement(client, { ...input, adminId, reason: input.reason });
    await recordAudit(
      {
        adminId,
        action: 'stock_adjusted',
        tableName: 'stock_item',
        recordId: input.stockItemId,
        details: { type: input.type, quantity: input.quantity },
      },
      client,
    );
    return toStockItem((await repo.findStockItem(input.stockItemId, client))!);
  });
}

// --- Fulfilling an assistance request ------------------------------------------------------

export type FulfilResult = {
  request: RequestItem;
  given: Array<{ stockItemId: number; name: string; quantity: number; quantityOnHand: number }>;
};

/**
 * Records the help given for an approved request (Task 1, UC-03 steps 7 to 9):
 * each item becomes a movement out, stock goes down, and the request becomes
 * Fulfilled. If any item is short, nothing at all is saved (409 naming it).
 */
export async function fulfilRequest(
  adminId: number,
  requestId: number,
  input: FulfilInput,
): Promise<FulfilResult> {
  return withTransaction(async (client) => {
    const request = await findAssistanceRequest(requestId, client, { lock: true });
    if (!request) throw errors.notFound("We couldn't find that request.");
    if (!canMove('request', request.status, 'Fulfilled')) {
      throw errors.conflict(
        request.status === 'Submitted' || request.status === 'Under review'
          ? 'Approve the request before recording what was given.'
          : refusalMessage('request', request.status, 'Fulfilled'),
      );
    }

    const items = await repo.lockStockItems(
      client,
      input.items.map((line) => line.stockItemId),
    );
    input.items.forEach((line, index) => {
      const item = items.get(line.stockItemId);
      if (!item) {
        throw errors.validation([
          { field: `items.${index}.stockItemId`, message: 'Please choose a stock item.' },
        ]);
      }
      if (line.quantity > item.quantity_on_hand) {
        throw shortStock(item, line.quantity, `items.${index}.quantity`);
      }
    });

    const given: FulfilResult['given'] = [];
    for (const line of input.items) {
      const quantityOnHand = await repo.recordMovement(client, {
        stockItemId: line.stockItemId,
        type: 'Decrease',
        quantity: line.quantity,
        adminId,
        requestId,
        reason: null,
      });
      given.push({
        stockItemId: line.stockItemId,
        name: items.get(line.stockItemId)!.item_name,
        quantity: line.quantity,
        quantityOnHand,
      });
    }

    await saveDecision(client, 'request', requestId, {
      status: 'Fulfilled',
      adminId,
      reason: null,
    });
    await recordAudit(
      {
        adminId,
        action: 'assistance_request_fulfilled',
        tableName: 'assistance_request',
        recordId: requestId,
        details: {
          from: request.status,
          to: 'Fulfilled',
          items: input.items.map(({ stockItemId, quantity }) => ({ stockItemId, quantity })),
        },
      },
      client,
    );
    return {
      request: toRequestItem((await findAssistanceRequest(requestId, client))!),
      given,
    };
  });
}
