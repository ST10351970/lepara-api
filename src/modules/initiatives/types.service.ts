import { withTransaction } from '../../config/db';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { constraintOf } from '../../utils/pgErrors';
import * as repo from './initiatives.repository';
import type { TypeRow } from './initiatives.repository';
import type { CreateTypeInput, UpdateTypeInput } from './initiatives.schemas';

/** Event types (Garment donations, Pad drives, ...). Names are unique, ignoring capitals. */

export type PublicType = { typeId: number; name: string; description: string | null };
export type AdminType = PublicType & { initiativeCount: number };

const toPublicType = (row: TypeRow): PublicType => ({
  typeId: row.type_id,
  name: row.type_name,
  description: row.description,
});

const toAdminType = (row: TypeRow): AdminType => ({
  ...toPublicType(row),
  initiativeCount: row.initiative_count,
});

function nameTaken(): AppError {
  const message = 'There is already an event type with that name.';
  return new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'name', message }]);
}

export async function listPublicTypes(): Promise<PublicType[]> {
  return (await repo.listTypes()).map(toPublicType);
}

export async function listAdminTypes(): Promise<AdminType[]> {
  return (await repo.listTypes()).map(toAdminType);
}

export async function createType(adminId: number, input: CreateTypeInput): Promise<AdminType> {
  try {
    return await withTransaction(async (client) => {
      if (await repo.typeNameTaken(client, input.name, null)) throw nameTaken();
      const typeId = await repo.insertType(client, {
        name: input.name,
        description: input.description ?? null,
      });
      await recordAudit(
        {
          adminId,
          action: 'initiative_type_created',
          tableName: 'initiative_type',
          recordId: typeId,
        },
        client,
      );
      return toAdminType((await repo.findType(typeId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'initiative_type_type_name_key') throw nameTaken();
    throw error;
  }
}

export async function updateType(
  adminId: number,
  typeId: number,
  input: UpdateTypeInput,
): Promise<AdminType> {
  try {
    return await withTransaction(async (client) => {
      if (!(await repo.findType(typeId, client))) {
        throw errors.notFound("We couldn't find that event type.");
      }
      if (input.name !== undefined && (await repo.typeNameTaken(client, input.name, typeId))) {
        throw nameTaken();
      }
      await repo.updateType(client, typeId, input);
      await recordAudit(
        {
          adminId,
          action: 'initiative_type_updated',
          tableName: 'initiative_type',
          recordId: typeId,
        },
        client,
      );
      return toAdminType((await repo.findType(typeId, client))!);
    });
  } catch (error) {
    if (constraintOf(error) === 'initiative_type_type_name_key') throw nameTaken();
    throw error;
  }
}
