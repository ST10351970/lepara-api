import { withTransaction } from '../../config/db';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { constraintOf } from '../../utils/pgErrors';
import * as repo from './products.repository';
import type { CategoryRow } from './products.repository';
import type { CreateCategoryInput, UpdateCategoryInput } from './products.schemas';

/** Shop categories (T-shirts, Hoodies, Accessories). Names are unique, ignoring capitals. */

export type PublicCategory = { categoryId: number; name: string; productCount: number };
export type AdminCategory = {
  categoryId: number;
  name: string;
  sortOrder: number;
  productCount: number;
  activeProductCount: number;
};

/** productCount counts shown products only, so the app can skip empty categories. */
const toPublic = (row: CategoryRow): PublicCategory => ({
  categoryId: row.category_id,
  name: row.name,
  productCount: row.active_product_count,
});

const toAdmin = (row: CategoryRow): AdminCategory => ({
  categoryId: row.category_id,
  name: row.name,
  sortOrder: row.sort_order,
  productCount: row.product_count,
  activeProductCount: row.active_product_count,
});

function nameTaken(): AppError {
  const message = 'There is already a category with that name.';
  return new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'name', message }]);
}

export async function listPublicCategories(): Promise<PublicCategory[]> {
  return (await repo.listCategories()).map(toPublic);
}

export async function listAdminCategories(): Promise<AdminCategory[]> {
  return (await repo.listCategories()).map(toAdmin);
}

export async function createCategory(
  adminId: number,
  input: CreateCategoryInput,
): Promise<AdminCategory> {
  try {
    return await withTransaction(async (client) => {
      if (await repo.categoryNameTaken(client, input.name, null)) throw nameTaken();
      const categoryId = await repo.insertCategory(client, input);
      await recordAudit(
        {
          adminId,
          action: 'category_created',
          tableName: 'product_category',
          recordId: categoryId,
        },
        client,
      );
      return toAdmin((await repo.findCategory(categoryId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'product_category_name_key') throw nameTaken();
    throw error;
  }
}

export async function updateCategory(
  adminId: number,
  categoryId: number,
  input: UpdateCategoryInput,
): Promise<AdminCategory> {
  try {
    return await withTransaction(async (client) => {
      if (!(await repo.findCategory(categoryId, client))) {
        throw errors.notFound("We couldn't find that category.");
      }
      if (
        input.name !== undefined &&
        (await repo.categoryNameTaken(client, input.name, categoryId))
      ) {
        throw nameTaken();
      }
      await repo.updateCategory(client, categoryId, input);
      await recordAudit(
        {
          adminId,
          action: 'category_updated',
          tableName: 'product_category',
          recordId: categoryId,
        },
        client,
      );
      return toAdmin((await repo.findCategory(categoryId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'product_category_name_key') throw nameTaken();
    throw error;
  }
}
