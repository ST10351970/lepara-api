import { type Queryable, pool, query } from '../../config/db';
import { likeContains } from '../../utils/sql';

/**
 * Queries for the shop: products, their sizes (variants) and categories.
 * Values always go in as $1, $2, ...: a search for "'; DROP TABLE product; --"
 * is just text to look for. Column names come only from the fixed lists here.
 */

export type VariantRow = {
  variantId: number;
  size: string;
  sku: string;
  quantityOnHand: number;
};

export type ProductRow = {
  product_id: number;
  category_id: number;
  category_name: string;
  name: string;
  colour: string | null;
  material: string | null;
  description: string | null;
  price_cents: number;
  image_url: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  /** Smallest size first. */
  variants: VariantRow[];
};

const PRODUCT_COLUMNS = `p.product_id, p.category_id, c.name AS category_name, p.name, p.colour,
  p.material, p.description, p.price_cents, p.image_url, p.is_active, p.created_at, p.updated_at,
  COALESCE((
    SELECT json_agg(
             json_build_object('variantId', v.variant_id, 'size', v.size, 'sku', v.sku,
                               'quantityOnHand', v.quantity_on_hand)
             ORDER BY array_position(ARRAY['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size'], v.size::text))
    FROM product_variant v WHERE v.product_id = p.product_id
  ), '[]'::json) AS variants`;

const FROM_PRODUCTS = 'FROM product p JOIN product_category c ON c.category_id = p.category_id';

// --- Products --------------------------------------------------------------------

/**
 * Products for the shop or the dashboard. $1 is active/hidden/both, $2 the
 * search (name, colour, material or category), $3 the category.
 */
export async function listProducts(filters: {
  isActive: boolean | null;
  search: string | undefined;
  categoryId: number | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: ProductRow[]; total: number }> {
  const where = `($1::boolean IS NULL OR p.is_active = $1)
    AND ($2::text IS NULL OR p.name ILIKE $2 OR p.colour ILIKE $2 OR p.material ILIKE $2
         OR c.name ILIKE $2)
    AND ($3::int IS NULL OR p.category_id = $3)`;
  const values = [
    filters.isActive,
    filters.search ? likeContains(filters.search) : null,
    filters.categoryId ?? null,
  ];
  const [page, count] = await Promise.all([
    query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} ${FROM_PRODUCTS}
       WHERE ${where}
       ORDER BY c.sort_order, c.name, p.name, p.product_id
       LIMIT $4 OFFSET $5`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total ${FROM_PRODUCTS} WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function findProduct(
  productId: number,
  db: Queryable = pool,
): Promise<ProductRow | null> {
  const { rows } = await query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${FROM_PRODUCTS} WHERE p.product_id = $1`,
    [productId],
    db,
  );
  return rows[0] ?? null;
}

/** Locks the product's row until the transaction ends, so two changes can't overlap. */
export async function lockProduct(db: Queryable, productId: number): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM product WHERE product_id = $1 FOR UPDATE',
    [productId],
    db,
  );
  return rows.length === 1;
}

export type ProductValues = {
  categoryId: number;
  name: string;
  colour: string | null;
  material: string | null;
  description: string | null;
  priceCents: number;
  isActive: boolean;
};

const COLUMNS: Record<keyof ProductValues, string> = {
  categoryId: 'category_id',
  name: 'name',
  colour: 'colour',
  material: 'material',
  description: 'description',
  priceCents: 'price_cents',
  isActive: 'is_active',
};

export async function insertProduct(db: Queryable, values: ProductValues): Promise<number> {
  const keys = Object.keys(COLUMNS) as Array<keyof ProductValues>;
  const { rows } = await query<{ product_id: number }>(
    `INSERT INTO product (${keys.map((key) => COLUMNS[key]).join(', ')})
     VALUES (${keys.map((_key, index) => `$${index + 1}`).join(', ')})
     RETURNING product_id`,
    keys.map((key) => values[key]),
    db,
  );
  return rows[0]!.product_id;
}

/** Saves only the fields given, and records when the product last changed. */
export async function updateProduct(
  db: Queryable,
  productId: number,
  changes: Partial<ProductValues>,
): Promise<void> {
  const values: unknown[] = [productId];
  const assignments: string[] = [];
  for (const key of Object.keys(COLUMNS) as Array<keyof ProductValues>) {
    if (changes[key] === undefined) continue;
    values.push(changes[key]);
    assignments.push(`${COLUMNS[key]} = $${values.length}`);
  }
  if (assignments.length === 0) return;
  await query(
    `UPDATE product SET ${assignments.join(', ')}, updated_at = now() WHERE product_id = $1`,
    values,
    db,
  );
}

export async function setProductImage(
  db: Queryable,
  productId: number,
  imageUrl: string,
): Promise<void> {
  await query(
    'UPDATE product SET image_url = $2, updated_at = now() WHERE product_id = $1',
    [productId, imageUrl],
    db,
  );
}

// --- Sizes (variants) ---------------------------------------------------------------

export async function insertVariant(
  db: Queryable,
  productId: number,
  variant: { size: string; sku: string; quantityOnHand: number },
): Promise<number> {
  const { rows } = await query<{ variant_id: number }>(
    `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand)
     VALUES ($1, $2, $3, $4) RETURNING variant_id`,
    [productId, variant.size, variant.sku, variant.quantityOnHand],
    db,
  );
  return rows[0]!.variant_id;
}

export async function findVariant(
  db: Queryable,
  productId: number,
  variantId: number,
): Promise<VariantRow | null> {
  const { rows } = await query<VariantRow>(
    `SELECT variant_id AS "variantId", size, sku, quantity_on_hand AS "quantityOnHand"
     FROM product_variant WHERE product_id = $1 AND variant_id = $2`,
    [productId, variantId],
    db,
  );
  return rows[0] ?? null;
}

export async function updateVariant(
  db: Queryable,
  variantId: number,
  changes: { sku?: string; quantityOnHand?: number },
): Promise<void> {
  await query(
    `UPDATE product_variant
     SET sku = COALESCE($2, sku), quantity_on_hand = COALESCE($3::int, quantity_on_hand)
     WHERE variant_id = $1`,
    [variantId, changes.sku ?? null, changes.quantityOnHand ?? null],
    db,
  );
}

export async function touchProduct(db: Queryable, productId: number): Promise<void> {
  await query('UPDATE product SET updated_at = now() WHERE product_id = $1', [productId], db);
}

// --- Categories ------------------------------------------------------------------------

export type CategoryRow = {
  category_id: number;
  name: string;
  sort_order: number;
  active_product_count: number;
  product_count: number;
};

const CATEGORY_COLUMNS = `c.category_id, c.name, c.sort_order,
  (SELECT count(*)::int FROM product p WHERE p.category_id = c.category_id AND p.is_active)
    AS active_product_count,
  (SELECT count(*)::int FROM product p WHERE p.category_id = c.category_id) AS product_count`;

export async function listCategories(): Promise<CategoryRow[]> {
  const { rows } = await query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM product_category c ORDER BY c.sort_order, c.name`,
  );
  return rows;
}

export async function findCategory(
  categoryId: number,
  db: Queryable = pool,
): Promise<CategoryRow | null> {
  const { rows } = await query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM product_category c WHERE c.category_id = $1`,
    [categoryId],
    db,
  );
  return rows[0] ?? null;
}

/** True if another category already has this name (capitals ignored). */
export async function categoryNameTaken(
  db: Queryable,
  name: string,
  exceptCategoryId: number | null,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM product_category
     WHERE lower(name) = lower($1) AND ($2::int IS NULL OR category_id <> $2)`,
    [name, exceptCategoryId],
    db,
  );
  return rows.length > 0;
}

export async function insertCategory(
  db: Queryable,
  category: { name: string; sortOrder: number },
): Promise<number> {
  const { rows } = await query<{ category_id: number }>(
    'INSERT INTO product_category (name, sort_order) VALUES ($1, $2) RETURNING category_id',
    [category.name, category.sortOrder],
    db,
  );
  return rows[0]!.category_id;
}

export async function updateCategory(
  db: Queryable,
  categoryId: number,
  changes: { name?: string; sortOrder?: number },
): Promise<void> {
  await query(
    `UPDATE product_category
     SET name = COALESCE($2, name), sort_order = COALESCE($3::int, sort_order)
     WHERE category_id = $1`,
    [categoryId, changes.name ?? null, changes.sortOrder ?? null],
    db,
  );
}
