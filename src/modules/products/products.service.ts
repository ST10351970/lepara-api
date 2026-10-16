import { type Queryable, withTransaction } from '../../config/db';
import type { UploadedImage } from '../../middleware/upload';
import { deleteImage, imageStorageReady, saveImage } from '../../services/imageStorage';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { formatPrice } from '../../utils/money';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import { constraintOf } from '../../utils/pgErrors';
import type { PageMeta } from '../../utils/respond';
import { type Availability, availabilityOf, productSubtitle } from './products.format';
import * as repo from './products.repository';
import type { ProductRow, ProductValues } from './products.repository';
import type {
  AdminListQuery,
  CreateProductInput,
  CreateVariantInput,
  PublicListQuery,
  UpdateProductInput,
  UpdateVariantInput,
} from './products.schemas';

/**
 * The shop's products and their sizes.
 *  - Hidden products (isActive false) never appear in the app. Products are
 *    hidden, never deleted, because orders refer to them.
 *  - A product can only be shown once it has at least one size.
 *  - The app sees "In stock", "Low stock" or "Sold out" per size, never the
 *    exact count; the dashboard sees the real numbers.
 *  - Prices are whole cents; `price` is the label for the screen ("R250").
 *  - Every change goes in the audit log.
 */

// --- What the app and dashboard receive --------------------------------------------

/** One product card in the Shop or on Home. */
export type ProductCard = {
  productId: number;
  name: string;
  categoryId: number;
  categoryName: string;
  colour: string | null;
  material: string | null;
  priceCents: number;
  price: string;
  subtitle: string;
  imageUrl: string | null;
  sizes: string[];
  inStock: boolean;
};

/** The product page: the card, its description, and each size's availability. */
export type ProductPage = ProductCard & {
  description: string | null;
  variants: Array<{ variantId: number; size: string; availability: Availability }>;
};

/** The dashboard: everything, with real stock numbers and SKU codes. */
export type AdminProduct = ProductCard & {
  description: string | null;
  isActive: boolean;
  totalStock: number;
  variants: Array<{ variantId: number; size: string; sku: string; quantityOnHand: number }>;
  createdAt: Date;
  updatedAt: Date;
};

function toCard(row: ProductRow): ProductCard {
  const sizes = row.variants.map((variant) => variant.size);
  return {
    productId: row.product_id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    colour: row.colour,
    material: row.material,
    priceCents: row.price_cents,
    price: formatPrice(row.price_cents),
    subtitle: productSubtitle(row.colour, row.material, sizes),
    imageUrl: row.image_url,
    sizes,
    inStock: row.variants.some((variant) => variant.quantityOnHand > 0),
  };
}

function toPage(row: ProductRow): ProductPage {
  return {
    ...toCard(row),
    description: row.description,
    variants: row.variants.map((variant) => ({
      variantId: variant.variantId,
      size: variant.size,
      availability: availabilityOf(variant.quantityOnHand),
    })),
  };
}

function toAdmin(row: ProductRow): AdminProduct {
  return {
    ...toCard(row),
    description: row.description,
    isActive: row.is_active,
    totalStock: row.variants.reduce((sum, variant) => sum + variant.quantityOnHand, 0),
    variants: row.variants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const productNotFound = () => errors.notFound("We couldn't find that product.");

function fieldConflict(field: string, message: string): AppError {
  return new AppError(409, ErrorCode.CONFLICT, message, [{ field, message }]);
}

/** Friendly 409s for a repeated size or SKU, from the database's own unique rules. */
function variantConflict(error: unknown): AppError | null {
  const constraint = constraintOf(error);
  if (constraint === 'product_variant_size_key') {
    return fieldConflict('size', 'This product already has that size.');
  }
  if (constraint === 'product_variant_sku_key') {
    return fieldConflict('sku', 'Another size already uses that SKU code.');
  }
  return null;
}

const needsASize = () =>
  errors.validation([
    {
      field: 'isActive',
      message: 'Add at least one size before showing this product in the shop.',
    },
  ]);

const audit = (
  db: Queryable,
  adminId: number,
  action: string,
  tableName: 'product' | 'product_variant',
  recordId: number,
  details?: Record<string, unknown>,
) => recordAudit({ adminId, action, tableName, recordId, details }, db);

async function assertCategoryExists(categoryId: number, db: Queryable): Promise<void> {
  if (!(await repo.findCategory(categoryId, db))) {
    throw errors.validation([
      { field: 'categoryId', message: 'Please choose one of the categories.' },
    ]);
  }
}

// --- Public -------------------------------------------------------------------------

export async function listShopProducts(
  filters: PublicListQuery,
): Promise<{ items: ProductCard[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listProducts({
    isActive: true,
    search: filters.search,
    categoryId: filters.categoryId,
    limit,
    offset,
  });
  return { items: rows.map(toCard), meta: pageMeta(filters.page, filters.pageSize, total) };
}

/** Hidden products answer 404, as if they didn't exist. */
export async function getShopProduct(productId: number): Promise<ProductPage> {
  const row = await repo.findProduct(productId);
  if (!row || !row.is_active) throw productNotFound();
  return toPage(row);
}

// --- Admin: products -------------------------------------------------------------------

export async function listAdminProducts(
  filters: AdminListQuery,
): Promise<{ items: AdminProduct[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listProducts({
    isActive: filters.status === 'all' ? null : filters.status === 'active',
    search: filters.search,
    categoryId: filters.categoryId,
    limit,
    offset,
  });
  return { items: rows.map(toAdmin), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function getAdminProduct(productId: number, db?: Queryable): Promise<AdminProduct> {
  const row = await repo.findProduct(productId, db);
  if (!row) throw productNotFound();
  return toAdmin(row);
}

/** A new product, with any sizes given. Hidden unless isActive is true (which needs a size). */
export async function createProduct(
  adminId: number,
  input: CreateProductInput,
): Promise<AdminProduct> {
  if (input.isActive && input.variants.length === 0) throw needsASize();
  try {
    return await withTransaction(async (client) => {
      await assertCategoryExists(input.categoryId, client);
      const productId = await repo.insertProduct(client, {
        categoryId: input.categoryId,
        name: input.name,
        colour: input.colour ?? null,
        material: input.material ?? null,
        description: input.description ?? null,
        priceCents: input.price,
        isActive: input.isActive,
      });
      for (const variant of input.variants) await repo.insertVariant(client, productId, variant);
      await audit(client, adminId, 'product_created', 'product', productId, {
        sizes: input.variants.map((variant) => variant.size),
      });
      return getAdminProduct(productId, client);
    });
  } catch (error) {
    throw variantConflict(error) ?? error;
  }
}

/** Changes details, price, or whether the product is shown. Only real changes are saved. */
export async function updateProduct(
  adminId: number,
  productId: number,
  input: UpdateProductInput,
): Promise<AdminProduct> {
  return withTransaction(async (client) => {
    if (!(await repo.lockProduct(client, productId))) throw productNotFound();
    const row = (await repo.findProduct(productId, client))!;

    const before: ProductValues = {
      categoryId: row.category_id,
      name: row.name,
      colour: row.colour,
      material: row.material,
      description: row.description,
      priceCents: row.price_cents,
      isActive: row.is_active,
    };
    const requested: Partial<ProductValues> = {
      categoryId: input.categoryId,
      name: input.name,
      colour: input.colour,
      material: input.material,
      description: input.description,
      priceCents: input.price,
      isActive: input.isActive,
    };
    const changes: Partial<ProductValues> = {};
    for (const key of Object.keys(before) as Array<keyof ProductValues>) {
      const value = requested[key];
      if (value !== undefined && value !== before[key]) Object.assign(changes, { [key]: value });
    }
    if (Object.keys(changes).length === 0) return toAdmin(row);

    if (changes.isActive === true && row.variants.length === 0) throw needsASize();
    if (changes.categoryId !== undefined) await assertCategoryExists(changes.categoryId, client);

    await repo.updateProduct(client, productId, changes);
    const action =
      changes.isActive === true
        ? 'product_shown'
        : changes.isActive === false
          ? 'product_hidden'
          : 'product_updated';
    await audit(client, adminId, action, 'product', productId, {
      changed: Object.keys(changes),
      ...(changes.priceCents !== undefined
        ? { priceCents: { from: before.priceCents, to: changes.priceCents } }
        : {}),
    });
    return getAdminProduct(productId, client);
  });
}

/** Saves a new photo for the product, then removes the old one from storage. */
export async function setProductImage(
  adminId: number,
  productId: number,
  image: UploadedImage,
): Promise<AdminProduct> {
  if (!imageStorageReady()) {
    throw errors.unavailable('Photo uploads are not set up yet. Please try again later.');
  }
  if (!(await repo.findProduct(productId))) throw productNotFound();

  const imageUrl = await saveImage(image, 'products');
  try {
    const { product, previousUrl } = await withTransaction(async (client) => {
      if (!(await repo.lockProduct(client, productId))) throw productNotFound();
      const row = (await repo.findProduct(productId, client))!;
      await repo.setProductImage(client, productId, imageUrl);
      await audit(client, adminId, 'product_image_changed', 'product', productId);
      return { product: await getAdminProduct(productId, client), previousUrl: row.image_url };
    });
    await deleteImage(previousUrl);
    return product;
  } catch (error) {
    await deleteImage(imageUrl); // the new photo isn't used after all
    throw error;
  }
}

// --- Admin: sizes ------------------------------------------------------------------------

export async function addVariant(
  adminId: number,
  productId: number,
  input: CreateVariantInput,
): Promise<AdminProduct> {
  try {
    return await withTransaction(async (client) => {
      if (!(await repo.lockProduct(client, productId))) throw productNotFound();
      const variantId = await repo.insertVariant(client, productId, input);
      await repo.touchProduct(client, productId);
      await audit(client, adminId, 'variant_created', 'product_variant', variantId, {
        productId,
        size: input.size,
        quantityOnHand: input.quantityOnHand,
      });
      return getAdminProduct(productId, client);
    });
  } catch (error) {
    throw variantConflict(error) ?? error;
  }
}

/** Changes a size's SKU code or how many are in stock. */
export async function updateVariant(
  adminId: number,
  productId: number,
  variantId: number,
  input: UpdateVariantInput,
): Promise<AdminProduct> {
  try {
    return await withTransaction(async (client) => {
      if (!(await repo.lockProduct(client, productId))) throw productNotFound();
      const variant = await repo.findVariant(client, productId, variantId);
      if (!variant) throw errors.notFound("We couldn't find that size.");

      const changes: { sku?: string; quantityOnHand?: number } = {};
      if (input.sku !== undefined && input.sku !== variant.sku) changes.sku = input.sku;
      if (input.quantityOnHand !== undefined && input.quantityOnHand !== variant.quantityOnHand) {
        changes.quantityOnHand = input.quantityOnHand;
      }
      if (Object.keys(changes).length === 0) return getAdminProduct(productId, client);

      await repo.updateVariant(client, variantId, changes);
      await repo.touchProduct(client, productId);
      await audit(client, adminId, 'variant_updated', 'product_variant', variantId, {
        productId,
        size: variant.size,
        ...(changes.sku ? { sku: { from: variant.sku, to: changes.sku } } : {}),
        ...(changes.quantityOnHand !== undefined
          ? { quantityOnHand: { from: variant.quantityOnHand, to: changes.quantityOnHand } }
          : {}),
      });
      return getAdminProduct(productId, client);
    });
  } catch (error) {
    throw variantConflict(error) ?? error;
  }
}
