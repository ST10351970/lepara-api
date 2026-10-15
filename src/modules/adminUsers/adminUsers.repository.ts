import { type Queryable, pool, query } from '../../config/db';
import { likeContains } from '../../utils/sql';
import type { AdminRole } from '../adminAuth/adminAuth.repository';

/**
 * Queries for managing admin accounts. Values always go in as $1, $2, ...
 * Column names come only from the fixed lists written in this file.
 */

export type AdminSummaryRow = {
  admin_id: number;
  username: string;
  full_name: string;
  email: string;
  role: AdminRole;
  is_active: boolean;
  two_factor_enabled: boolean;
  must_change_password: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
};

// Never the password hash or the authenticator secret.
const SUMMARY_COLUMNS = `admin_id, username, full_name, email, role, is_active, two_factor_enabled,
  must_change_password, CASE WHEN locked_until > now() THEN locked_until END AS locked_until,
  last_login_at, created_at`;

export async function listAdmins(filters: {
  isActive: boolean | null;
  search: string | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: AdminSummaryRow[]; total: number }> {
  const where = `($1::boolean IS NULL OR is_active = $1)
    AND ($2::text IS NULL OR username ILIKE $2 OR full_name ILIKE $2 OR email ILIKE $2)`;
  const pattern = filters.search ? likeContains(filters.search) : null;

  const [page, count] = await Promise.all([
    query<AdminSummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM admin_user
       WHERE ${where}
       ORDER BY is_active DESC, full_name, admin_id
       LIMIT $3 OFFSET $4`,
      [filters.isActive, pattern, filters.limit, filters.offset],
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total FROM admin_user WHERE ${where}`, [
      filters.isActive,
      pattern,
    ]),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function findAdmin(
  adminId: number,
  db: Queryable = pool,
): Promise<AdminSummaryRow | null> {
  const { rows } = await query<AdminSummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM admin_user WHERE admin_id = $1`,
    [adminId],
    db,
  );
  return rows[0] ?? null;
}

/** Finds an admin and locks the row until the transaction ends. */
export async function findAdminForUpdate(
  db: Queryable,
  adminId: number,
): Promise<AdminSummaryRow | null> {
  const { rows } = await query<AdminSummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM admin_user WHERE admin_id = $1 FOR UPDATE`,
    [adminId],
    db,
  );
  return rows[0] ?? null;
}

/**
 * Locks every active super admin, always in the same order. Two super admins
 * changing each other at the same moment then take turns, so both can't
 * succeed and leave nobody in charge.
 */
export async function lockActiveSuperAdmins(db: Queryable): Promise<number[]> {
  const { rows } = await query<{ admin_id: number }>(
    `SELECT admin_id FROM admin_user
     WHERE role = 'super_admin' AND is_active
     ORDER BY admin_id
     FOR UPDATE`,
    [],
    db,
  );
  return rows.map((row) => row.admin_id);
}

export async function insertAdmin(
  db: Queryable,
  admin: {
    username: string;
    email: string;
    fullName: string;
    role: AdminRole;
    passwordHash: string;
  },
): Promise<AdminSummaryRow> {
  const { rows } = await query<AdminSummaryRow>(
    `INSERT INTO admin_user (username, email, password_hash, full_name, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING ${SUMMARY_COLUMNS}`,
    [admin.username, admin.email, admin.passwordHash, admin.fullName, admin.role],
    db,
  );
  return rows[0]!;
}

export type AdminChanges = {
  fullName?: string;
  email?: string;
  role?: AdminRole;
  isActive?: boolean;
};

const CHANGE_COLUMNS: Record<keyof AdminChanges, string> = {
  fullName: 'full_name',
  email: 'email',
  role: 'role',
  isActive: 'is_active',
};

/** Saves only the fields given. Reactivating also clears any lock from wrong passwords. */
export async function updateAdmin(
  db: Queryable,
  adminId: number,
  changes: AdminChanges,
): Promise<AdminSummaryRow> {
  const values: unknown[] = [adminId];
  const assignments: string[] = [];
  for (const key of Object.keys(CHANGE_COLUMNS) as Array<keyof AdminChanges>) {
    if (changes[key] === undefined) continue;
    values.push(changes[key]);
    assignments.push(`${CHANGE_COLUMNS[key]} = $${values.length}`);
  }
  if (changes.isActive === true) assignments.push('failed_login_count = 0', 'locked_until = NULL');

  const { rows } = await query<AdminSummaryRow>(
    `UPDATE admin_user SET ${assignments.join(', ')}
     WHERE admin_id = $1
     RETURNING ${SUMMARY_COLUMNS}`,
    values,
    db,
  );
  return rows[0]!;
}

/** Removes the authenticator app and backup codes; the next sign-in sets them up again. */
export async function clearTwoFactor(db: Queryable, adminId: number): Promise<void> {
  await query(
    `UPDATE admin_user
     SET two_factor_enabled = false, totp_secret_encrypted = NULL, totp_last_used_step = NULL
     WHERE admin_id = $1`,
    [adminId],
    db,
  );
  await query('DELETE FROM admin_backup_code WHERE admin_id = $1', [adminId], db);
}

/** A new temporary password, which must be changed at the next sign-in. Also clears any lock. */
export async function setTemporaryPassword(
  db: Queryable,
  adminId: number,
  passwordHash: string,
): Promise<void> {
  await query(
    `UPDATE admin_user
     SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL
     WHERE admin_id = $1`,
    [adminId, passwordHash],
    db,
  );
}
