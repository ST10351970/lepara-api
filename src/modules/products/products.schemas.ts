import { z } from 'zod';
import {
  description,
  pagination,
  randsToCents,
  requiredText,
  searchText,
  shortText,
} from '../../schemas/common';
import { SIZES } from './products.format';

/** What the shop endpoints accept. Messages appear on the website's forms. */

const positiveId = (message: string) =>
  z.number({ error: message }).int(message).positive(message).max(2_147_483_647, message);

const routeId = (message: string) =>
  z.coerce.number({ error: message }).int(message).positive(message).max(2_147_483_647, message);

/** An optional ?categoryId= filter: anything that isn't a valid ID is ignored. */
const optionalCategoryId = z.coerce
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .optional()
  .catch(undefined);

// --- Lists --------------------------------------------------------------------

/** GET /products?search=&categoryId=&page=&pageSize= */
export const publicListQuery = pagination.extend({
  search: searchText,
  categoryId: optionalCategoryId,
});
export type PublicListQuery = z.infer<typeof publicListQuery>;

/** GET /admin/products?status=active|inactive|all&search=&categoryId= */
export const adminListQuery = publicListQuery.extend({
  status: z.enum(['active', 'inactive', 'all']).catch('all'),
});
export type AdminListQuery = z.infer<typeof adminListQuery>;

// --- Sizes (variants) ------------------------------------------------------------

const size = z.enum(SIZES, {
  error: 'Please choose a size: XS, S, M, L, XL, XXL or One size.',
});

/** Stock-keeping unit, the shop's own code for one size, e.g. TEE-WHT-M. Stored in capitals. */
const sku = requiredText('Please enter the SKU code.')
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9][A-Z0-9-]{1,39}$/,
    'SKU codes are 2 to 40 letters, numbers or dashes, for example TEE-WHT-M.',
  );

const quantityOnHand = z
  .number({ error: 'Please enter how many are in stock, as a whole number.' })
  .int('Please enter how many are in stock, as a whole number.')
  .min(0, "Stock can't be below 0.")
  .max(100_000, 'Please enter a number up to 100 000.');

export const createVariantSchema = z.object({
  size,
  sku,
  quantityOnHand: quantityOnHand.default(0),
});
export type CreateVariantInput = z.infer<typeof createVariantSchema>;

/** The size itself can't change (orders refer to it); add a new size instead. */
export const updateVariantSchema = z
  .object({ sku: sku.optional(), quantityOnHand: quantityOnHand.optional() })
  .refine(
    (changes) => changes.sku !== undefined || changes.quantityOnHand !== undefined,
    'Please change at least one detail.',
  );
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

/** /admin/products/:id/variants/:variantId */
export const variantParams = z.object({
  id: routeId("We couldn't find that product."),
  variantId: routeId("We couldn't find that size."),
});

// --- Products --------------------------------------------------------------------

const price = randsToCents(100_000).refine((cents) => cents > 0, 'The price must be more than R0.');

const fields = {
  categoryId: positiveId('Please choose a category.'),
  name: shortText('Please enter the product name.', 2, 120),
  colour: shortText('Please enter the colour.', 2, 40).nullable(),
  material: shortText('Please enter the material.', 2, 60).nullable(),
  description: description(10, 2000).nullable(),
  price,
  isActive: z.boolean({ error: 'Please choose whether the product is shown in the shop.' }),
};

/**
 * A new product. It starts hidden from the shop unless isActive is true, and
 * can only be shown once it has at least one size. Sizes can be added here
 * or afterwards.
 */
export const createProductSchema = z
  .object({
    categoryId: fields.categoryId,
    name: fields.name,
    colour: fields.colour.optional(),
    material: fields.material.optional(),
    description: fields.description.optional(),
    price: fields.price,
    isActive: fields.isActive.default(false),
    variants: z.array(createVariantSchema, { error: 'Please list the sizes.' }).max(7).default([]),
  })
  .superRefine((product, ctx) => {
    const seen = new Set<string>();
    product.variants.forEach((variant, index) => {
      if (seen.has(variant.size)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', index, 'size'],
          message: 'Each size can only be listed once.',
        });
      }
      seen.add(variant.size);
    });
  });
export type CreateProductInput = z.infer<typeof createProductSchema>;

/** Any field can change; send null to clear an optional one. Products are hidden, never deleted. */
export const updateProductSchema = z
  .object({
    categoryId: fields.categoryId.optional(),
    name: fields.name.optional(),
    colour: fields.colour.optional(),
    material: fields.material.optional(),
    description: fields.description.optional(),
    price: fields.price.optional(),
    isActive: fields.isActive.optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Please change at least one detail.',
  );
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// --- Categories ------------------------------------------------------------------

const categoryName = shortText('Please enter the category name.', 2, 60);
const sortOrder = z
  .number({ error: 'Please enter the position as a whole number.' })
  .int('Please enter the position as a whole number.')
  .min(0, 'The position must be 0 or more.')
  .max(1000, 'Please enter a position up to 1000.');

export const createCategorySchema = z.object({
  name: categoryName,
  sortOrder: sortOrder.default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({ name: categoryName.optional(), sortOrder: sortOrder.optional() })
  .refine(
    (changes) => changes.name !== undefined || changes.sortOrder !== undefined,
    'Please change at least one detail.',
  );
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
