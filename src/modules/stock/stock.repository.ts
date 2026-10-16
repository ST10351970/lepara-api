import { type Queryable, pool, query } from '../../config/db';
import { likeContains, pickSort } from '../../utils/sql';

/**
 * Queries for stock items and their movements. Values always go in as $1,
 * $2, ...; sort orders come only from the fixed list below.
 *
 * The one rule this file keeps: quantity_on_hand only ever changes together
 * with a stock_movement row (recordMovement), so an item's movements always
 * add up to its quantity on hand.
 */

export type StockItemRow = {
  stock_item_id: number;
  item_name: string;
  category: string | null;
  unit_of_measure: string;
  quantity_on_hand: number;
  reorder_level: number;
};

const ITEM_COLUMNS = `stock_item_id, item_name, category, unit_of_measure, quantity_on_hand,
  reorder_level`;

const ITEM_SORTS = {
  name: 'item_name ASC, stock_item_id ASC',
  quantity: 'quantity_on_hand ASC, item_name ASC',
  category: 'category ASC NULLS LAST, item_name ASC',
};
export const STOCK_SORT_KEYS = Object.keys(ITEM_SORTS);

export async function listStockItems(filters: {
  search?: string;
  category?: string;
  low: boolean;
  sort?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: StockItemRow[]; total: number }> {
  const where = `($1::text IS NULL OR item_name ILIKE $1 OR category ILIKE $1)
    AND ($2::text IS NULL OR lower(category) = lower($2))
    AND (NOT $3::boolean OR quantity_on_hand <= reorder_level)`;
  const values = [
    filters.search ? likeContains(filters.search) : null,
    filters.category ?? null,
    filters.low,
  ];
  const [page, count] = await Promise.all([
    query<StockItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM stock_item WHERE ${where}
       ORDER BY ${pickSort(filters.sort, ITEM_SORTS, 'name')}
       LIMIT $4 OFFSET $5`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM stock_item WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function findStockItem(
  stockItemId: number,
  db: Queryable = pool,
): Promise<StockItemRow | null> {
  const { rows } = await query<StockItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM stock_item WHERE stock_item_id = $1`,
    [stockItemId],
    db,
  );
  return rows[0] ?? null;
}

/**
 * Locks stock items until the transaction ends, always in ID order, so two
 * transactions locking the same items can't deadlock.
 */
export async function lockStockItems(
  db: Queryable,
  stockItemIds: number[],
): Promise<Map<number, StockItemRow>> {
  const { rows } = await query<StockItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM stock_item
     WHERE stock_item_id = ANY($1::int[])
     ORDER BY stock_item_id
     FOR UPDATE`,
    [stockItemIds],
    db,
  );
  return new Map(rows.map((row) => [row.stock_item_id, row]));
}

/** True if another item already has this name (capitals ignored). */
export async function itemNameTaken(
  db: Queryable,
  name: string,
  exceptId: number | null,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM stock_item
     WHERE lower(item_name) = lower($1) AND ($2::int IS NULL OR stock_item_id <> $2)`,
    [name, exceptId],
    db,
  );
  return rows.length > 0;
}

export async function insertStockItem(
  db: Queryable,
  values: { name: string; category: string | null; unit: string; reorderLevel: number },
): Promise<number> {
  const { rows } = await query<{ stock_item_id: number }>(
    `INSERT INTO stock_item (item_name, category, unit_of_measure, reorder_level)
     VALUES ($1, $2, $3, $4) RETURNING stock_item_id`,
    [values.name, values.category, values.unit, values.reorderLevel],
    db,
  );
  return rows[0]!.stock_item_id;
}

export type StockItemChanges = {
  item_name?: string;
  category?: string | null;
  unit_of_measure?: string;
  reorder_level?: number;
};

const CHANGEABLE: Array<keyof StockItemChanges> = [
  'item_name',
  'category',
  'unit_of_measure',
  'reorder_level',
];

export async function updateStockItem(
  db: Queryable,
  stockItemId: number,
  changes: StockItemChanges,
): Promise<void> {
  const columns = CHANGEABLE.filter((column) => changes[column] !== undefined);
  if (columns.length === 0) return;
  const sets = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  await query(
    `UPDATE stock_item SET ${sets} WHERE stock_item_id = $1`,
    [stockItemId, ...columns.map((column) => changes[column])],
    db,
  );
}

export type MovementSource =
  | { donationId: number; requestId?: undefined }
  | { requestId: number; donationId?: undefined }
  | { donationId?: undefined; requestId?: undefined };

/**
 * Records one movement and changes the quantity on hand by the same amount,
 * in the caller's transaction. The caller locks the item and checks there is
 * enough stock first; the database's own check (quantity_on_hand >= 0) is the
 * last line of defence. Returns the new quantity on hand.
 */
export async function recordMovement(
  db: Queryable,
  movement: {
    stockItemId: number;
    type: 'Increase' | 'Decrease';
    quantity: number;
    adminId: number;
    reason: string | null;
  } & MovementSource,
): Promise<number> {
  await query(
    `INSERT INTO stock_movement (stock_item_id, donation_id, request_id, recorded_by,
                                 movement_type, quantity, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      movement.stockItemId,
      movement.donationId ?? null,
      movement.requestId ?? null,
      movement.adminId,
      movement.type,
      movement.quantity,
      movement.reason,
    ],
    db,
  );
  const change = movement.type === 'Increase' ? movement.quantity : -movement.quantity;
  const { rows } = await query<{ quantity_on_hand: number }>(
    `UPDATE stock_item SET quantity_on_hand = quantity_on_hand + $2
     WHERE stock_item_id = $1 RETURNING quantity_on_hand`,
    [movement.stockItemId, change],
    db,
  );
  return rows[0]!.quantity_on_hand;
}

// --- Movement history ----------------------------------------------------------------------

export type MovementRow = {
  movement_id: number;
  movement_type: 'Increase' | 'Decrease';
  quantity: number;
  movement_date: Date;
  reason: string | null;
  donation_id: number | null;
  donor_name: string | null;
  donation_is_anonymous: boolean | null;
  request_id: number | null;
  request_reference: string | null;
  recorded_by: number;
  recorded_by_name: string;
};

export async function listMovements(
  stockItemId: number,
  page: { limit: number; offset: number },
): Promise<{ rows: MovementRow[]; total: number }> {
  const [rows, count] = await Promise.all([
    query<MovementRow>(
      `SELECT m.movement_id, m.movement_type, m.quantity, m.movement_date, m.reason,
              m.donation_id, d.donor_name, d.is_anonymous AS donation_is_anonymous,
              m.request_id, q.reference_number AS request_reference,
              m.recorded_by, a.full_name AS recorded_by_name
       FROM stock_movement m
       JOIN admin_user a ON a.admin_id = m.recorded_by
       LEFT JOIN donation d ON d.donation_id = m.donation_id
       LEFT JOIN assistance_request q ON q.request_id = m.request_id
       WHERE m.stock_item_id = $1
       ORDER BY m.movement_date DESC, m.movement_id DESC
       LIMIT $2 OFFSET $3`,
      [stockItemId, page.limit, page.offset],
    ),
    query<{ total: number }>(
      'SELECT count(*)::int AS total FROM stock_movement WHERE stock_item_id = $1',
      [stockItemId],
    ),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.total ?? 0 };
}
