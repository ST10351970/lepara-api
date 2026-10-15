import { type Queryable, withTransaction } from '../../config/db';
import { AppError, ErrorCode, errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import { hashPassword } from '../../utils/passwords';
import { constraintOf } from '../../utils/pgErrors';
import type { PageMeta } from '../../utils/respond';
import { endAllSessions } from '../adminAuth/adminAuth.repository';
import type { AdminRole } from '../adminAuth/adminAuth.repository';
import * as repo from './adminUsers.repository';
import type { AdminChanges, AdminSummaryRow } from './adminUsers.repository';
import type { CreateAdminInput, ListAdminsQuery, UpdateAdminInput } from './adminUsers.schemas';
import { generateTemporaryPassword } from './temporaryPassword';

/**
 * Managing admin accounts. Only super admins reach these functions (the
 * route checks the role). The rules:
 *  - A new admin gets a temporary password, shown once. At first sign-in
 *    they set up their authenticator app, then must change the password.
 *  - Deactivating an admin ends all their sessions at once.
 *  - Nobody can deactivate themselves or change their own role, and there
 *    is always at least one active super admin.
 *  - Every change is written to the audit log, with who made it.
 */

export type AdminSummary = {
  adminId: number;
  username: string;
  fullName: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  /** Set while the account is locked after wrong attempts. */
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

function toSummary(row: AdminSummaryRow): AdminSummary {
  return {
    adminId: row.admin_id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    twoFactorEnabled: row.two_factor_enabled,
    mustChangePassword: row.must_change_password,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const adminNotFound = () => errors.notFound("We couldn't find that admin.");

/** An audit row: who (actorId) did what (action) to which admin (targetId). */
const audit = (
  db: Queryable,
  actorId: number,
  action: string,
  targetId: number,
  details?: Record<string, unknown>,
) =>
  recordAudit(
    { adminId: actorId, action, tableName: 'admin_user', recordId: targetId, details },
    db,
  );

/** A friendly 409 for a username or email that another admin already has. */
function duplicateError(error: unknown): AppError | null {
  const constraint = constraintOf(error);
  if (constraint === 'admin_user_username_key') {
    const message = 'That username is already taken. Please choose another.';
    return new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'username', message }]);
  }
  if (constraint === 'admin_user_email_key') {
    const message = 'Another admin already uses this email address.';
    return new AppError(409, ErrorCode.CONFLICT, message, [{ field: 'email', message }]);
  }
  return null;
}

// --- Reading ------------------------------------------------------------------

export async function listAdmins(
  filters: ListAdminsQuery,
): Promise<{ items: AdminSummary[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const isActive = filters.status === 'all' ? null : filters.status === 'active';
  const { rows, total } = await repo.listAdmins({
    isActive,
    search: filters.search,
    limit,
    offset,
  });
  return { items: rows.map(toSummary), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function getAdmin(adminId: number): Promise<AdminSummary> {
  const row = await repo.findAdmin(adminId);
  if (!row) throw adminNotFound();
  return toSummary(row);
}

// --- Creating -------------------------------------------------------------------

export async function createAdmin(
  actorId: number,
  input: CreateAdminInput,
): Promise<{ admin: AdminSummary; temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const row = await withTransaction(async (client) => {
      const created = await repo.insertAdmin(client, { ...input, passwordHash });
      await audit(client, actorId, 'admin_created', created.admin_id, { role: created.role });
      return created;
    });
    return { admin: toSummary(row), temporaryPassword };
  } catch (error) {
    throw duplicateError(error) ?? error;
  }
}

// --- Changing ---------------------------------------------------------------------

/** Updates details, role or active status. Only fields that really change are saved. */
export async function updateAdmin(
  actorId: number,
  targetId: number,
  input: UpdateAdminInput,
): Promise<AdminSummary> {
  try {
    const row = await withTransaction(async (client) => {
      // Locked first, so role and status checks see the latest state (see repository).
      const affectsSuperAdmins = input.role !== undefined || input.isActive !== undefined;
      const activeSuperAdmins = affectsSuperAdmins ? await repo.lockActiveSuperAdmins(client) : [];

      const target = await repo.findAdminForUpdate(client, targetId);
      if (!target) throw adminNotFound();

      const changes: AdminChanges = {};
      if (input.fullName !== undefined && input.fullName !== target.full_name) {
        changes.fullName = input.fullName;
      }
      if (input.email !== undefined && input.email !== target.email.toLowerCase()) {
        changes.email = input.email;
      }
      if (input.role !== undefined && input.role !== target.role) changes.role = input.role;
      if (input.isActive !== undefined && input.isActive !== target.is_active) {
        changes.isActive = input.isActive;
      }
      if (Object.keys(changes).length === 0) return target; // nothing new: nothing to save

      if (targetId === actorId && changes.isActive === false) {
        throw errors.badRequest("You can't deactivate your own account.");
      }
      if (targetId === actorId && changes.role !== undefined) {
        throw errors.badRequest("You can't change your own role. Please ask another super admin.");
      }

      const stopsBeingSuperAdmin =
        target.role === 'super_admin' &&
        target.is_active &&
        (changes.role === 'staff' || changes.isActive === false);
      if (stopsBeingSuperAdmin && !activeSuperAdmins.some((id) => id !== targetId)) {
        throw errors.conflict('There must always be at least one active super admin.');
      }

      const updated = await repo.updateAdmin(client, targetId, changes);
      if (changes.isActive === false) {
        await endAllSessions(client, targetId, 'account_deactivated');
      }

      const action =
        changes.isActive === false
          ? 'admin_deactivated'
          : changes.isActive === true
            ? 'admin_reactivated'
            : 'admin_updated';
      await audit(client, actorId, action, targetId, {
        changed: Object.keys(changes),
        ...(changes.role ? { role: { from: target.role, to: changes.role } } : {}),
      });
      return updated;
    });
    return toSummary(row);
  } catch (error) {
    throw duplicateError(error) ?? error;
  }
}

/**
 * For a lost or replaced phone: removes the admin's authenticator app and
 * backup codes and ends their sessions. Their next sign-in sets up 2FA again.
 */
export async function resetTwoFactor(actorId: number, targetId: number): Promise<AdminSummary> {
  const row = await withTransaction(async (client) => {
    const target = await repo.findAdminForUpdate(client, targetId);
    if (!target) throw adminNotFound();
    await repo.clearTwoFactor(client, targetId);
    await endAllSessions(client, targetId, 'two_factor_reset');
    await audit(client, actorId, 'two_factor_reset', targetId);
    return repo.findAdmin(targetId, client);
  });
  return toSummary(row!);
}

/**
 * For a forgotten password: a new temporary password, shown once. The admin
 * must change it when they next sign in, and their sessions end now.
 */
export async function resetPassword(
  actorId: number,
  targetId: number,
): Promise<{ admin: AdminSummary; temporaryPassword: string }> {
  if (targetId === actorId) {
    throw errors.badRequest('To change your own password, use Change password instead.');
  }
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const row = await withTransaction(async (client) => {
    const target = await repo.findAdminForUpdate(client, targetId);
    if (!target) throw adminNotFound();
    await repo.setTemporaryPassword(client, targetId, passwordHash);
    await endAllSessions(client, targetId, 'password_reset');
    await audit(client, actorId, 'password_reset', targetId);
    return repo.findAdmin(targetId, client);
  });
  return { admin: toSummary(row!), temporaryPassword };
}
