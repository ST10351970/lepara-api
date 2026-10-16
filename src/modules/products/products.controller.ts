import type { Request, Response } from 'express';
import { currentAdmin } from '../../middleware/authenticate';
import { uploadedImage } from '../../middleware/upload';
import { validated } from '../../middleware/validate';
import { created, ok } from '../../utils/respond';
import * as categories from './categories.service';
import type {
  AdminListQuery,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  PublicListQuery,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateVariantInput,
} from './products.schemas';
import * as products from './products.service';

/** Thin layer: read the request, call the service, send the reply. */

type Id = { params: { id: number } };
type VariantId = { params: { id: number; variantId: number } };

// --- Public (the app and website, no sign-in) ----------------------------------

/** GET /products */
export async function listShop(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: PublicListQuery }>(res);
  const { items, meta } = await products.listShopProducts(query);
  ok(res, items, meta);
}

/** GET /products/:id */
export async function getShop(_req: Request, res: Response): Promise<void> {
  ok(res, await products.getShopProduct(validated<Id>(res).params.id));
}

/** GET /product-categories */
export async function listPublicCategories(_req: Request, res: Response): Promise<void> {
  ok(res, await categories.listPublicCategories());
}

// --- Admin: products -----------------------------------------------------------------

/** GET /admin/products */
export async function listAdmin(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: AdminListQuery }>(res);
  const { items, meta } = await products.listAdminProducts(query);
  ok(res, items, meta);
}

/** GET /admin/products/:id */
export async function getAdmin(_req: Request, res: Response): Promise<void> {
  ok(res, await products.getAdminProduct(validated<Id>(res).params.id));
}

/** POST /admin/products */
export async function create(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateProductInput }>(res);
  created(res, await products.createProduct(currentAdmin(res).adminId, body));
}

/** PATCH /admin/products/:id */
export async function update(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateProductInput }>(res);
  ok(res, await products.updateProduct(currentAdmin(res).adminId, params.id, body));
}

/** POST /admin/products/:id/image */
export async function uploadImage(_req: Request, res: Response): Promise<void> {
  const { params } = validated<Id>(res);
  ok(res, await products.setProductImage(currentAdmin(res).adminId, params.id, uploadedImage(res)));
}

/** POST /admin/products/:id/variants */
export async function addVariant(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: CreateVariantInput }>(res);
  created(res, await products.addVariant(currentAdmin(res).adminId, params.id, body));
}

/** PATCH /admin/products/:id/variants/:variantId */
export async function updateVariant(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<VariantId & { body: UpdateVariantInput }>(res);
  ok(
    res,
    await products.updateVariant(currentAdmin(res).adminId, params.id, params.variantId, body),
  );
}

// --- Admin: categories ------------------------------------------------------------------

/** GET /admin/product-categories */
export async function listAdminCategories(_req: Request, res: Response): Promise<void> {
  ok(res, await categories.listAdminCategories());
}

/** POST /admin/product-categories */
export async function createCategory(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: CreateCategoryInput }>(res);
  created(res, await categories.createCategory(currentAdmin(res).adminId, body));
}

/** PATCH /admin/product-categories/:id */
export async function updateCategory(_req: Request, res: Response): Promise<void> {
  const { params, body } = validated<Id & { body: UpdateCategoryInput }>(res);
  ok(res, await categories.updateCategory(currentAdmin(res).adminId, params.id, body));
}
