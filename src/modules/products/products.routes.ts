import { Router } from 'express';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './products.controller';
import {
  adminListQuery,
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  publicListQuery,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
  variantParams,
} from './products.schemas';

// --- Public: /api/v1/products and /api/v1/product-categories ----------------------

export const productsRouter = Router();
productsRouter.get('/', validate({ query: publicListQuery }), controller.listShop);
productsRouter.get('/:id', validate({ params: idParam }), controller.getShop);

export const productCategoriesRouter = Router();
productCategoriesRouter.get('/', controller.listPublicCategories);

// --- Admin: /api/v1/admin/products and /api/v1/admin/product-categories -----------
// Mounted behind authenticateAdmin: any signed-in admin (staff or super admin).

export const adminProductsRouter = Router();
adminProductsRouter.get('/', validate({ query: adminListQuery }), controller.listAdmin);
adminProductsRouter.post('/', validate({ body: createProductSchema }), controller.create);
adminProductsRouter.get('/:id', validate({ params: idParam }), controller.getAdmin);
adminProductsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateProductSchema }),
  controller.update,
);
// The photo is checked before anything else: size, then real file type.
adminProductsRouter.post(
  '/:id/image',
  validate({ params: idParam }),
  imageUpload,
  controller.uploadImage,
);
adminProductsRouter.post(
  '/:id/variants',
  validate({ params: idParam, body: createVariantSchema }),
  controller.addVariant,
);
adminProductsRouter.patch(
  '/:id/variants/:variantId',
  validate({ params: variantParams, body: updateVariantSchema }),
  controller.updateVariant,
);

export const adminProductCategoriesRouter = Router();
adminProductCategoriesRouter.get('/', controller.listAdminCategories);
adminProductCategoriesRouter.post(
  '/',
  validate({ body: createCategorySchema }),
  controller.createCategory,
);
adminProductCategoriesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateCategorySchema }),
  controller.updateCategory,
);
