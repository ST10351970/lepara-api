import { type Queryable, pool, query } from '../../config/db';

/**
 * Every query admin sign-in needs. Values always go in as $1, $2, ...
 * (ADMIN_COLUMNS below is a fixed list written here, never user input.)
 */

export type AdminRole = 'super_admin' | 'staff';

export type AdminAuthRow = {
  admin_id: number;
  username: string;
  email: string;
  full_name: string;
  role: AdminRole;
  password_hash: string;
  is_active: boolean;
  totp_secret_encrypted: string | null;
  two_factor_enabled: boolean;
  totp_last_used_step: number | null;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  session_version: number;
};

const ADMIN_COLUMNS = `admin_id, username, email, full_name, role, password_hash, is_active,
  totp_secret_encrypted, two_factor_enabled, totp_last_used_step, must_change_password,
  failed_login_count, locked_until, last_login_at, session_version`;

// --- Admins ------------------------------------------------------------------

export async function findAdminByUsername(
  username: string,
  db: Queryable = pool,
): Promise<AdminAuthRow | null> {
  const { rows } = await query<AdminAuthRow>(
    `SELECT ${ADMIN_COLUMNS} FROM admin_user WHERE username = $1`,
    [username],
    db,
  );
  return rows[0] ?? null;
}

export async function findAdminById(
  adminId: number,
  db: Queryable = pool,
): Promise<AdminAuthRow | null> {
  const { rows } = await query<AdminAuthRow>(
    `SELECT ${ADMIN_COLUMNS} FROM admin_user WHERE admin_id = $1`,
    [adminId],
    db,
  );
  return rows[0] ?? null;
}

/** What the sign-in check on every admin request needs: small and fast. */
export type AdminSessionRow = Pick<
  AdminAuthRow,
  'admin_id' | 'username' | 'role' | 'is_active' | 'session_version' | 'must_change_password'
>;

export async function findAdminSession(adminId: number): Promise<AdminSessionRow | null> {
  const { rows } = await query<AdminSessionRow>(
    `SELECT admin_id, username, role, is_active, session_version, must_change_password
     FROM admin_user WHERE admin_id = $1`,
    [adminId],
  );
  return rows[0] ?? null;
}

/**
 * Counts a wrong password or code. On the last allowed attempt the account
 * is locked and the count starts again. Returns when the lock ends, or null
 * if this attempt did not lock the account.
 */
export async function recordFailedAttempt(
  adminId: number,
  maxAttempts: number,
  lockMinutes: number,
): Promise<Date | null> {
  const { rows } = await query<{ locked_until: Date | null }>(
    `UPDATE admin_user
     SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0
                                   ELSE failed_login_count + 1 END,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3)
                             ELSE locked_until END
     WHERE admin_id = $1
     RETURNING CASE WHEN locked_until > now() THEN locked_until END AS locked_until`,
    [adminId, maxAttempts, lockMinutes],
  );
  return rows[0]?.locked_until ?? null;
}

/** A complete sign-in: clears failed attempts and records the time. */
export async function recordSuccessfulSignIn(
  db: Queryable,
  adminId: number,
): Promise<AdminAuthRow> {
  const { rows } = await query<AdminAuthRow>(
    `UPDATE admin_user
     SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
     WHERE admin_id = $1
     RETURNING ${ADMIN_COLUMNS}`,
    [adminId],
    db,
  );
  return rows[0]!;
}

export async function updatePassword(
  db: Queryable,
  adminId: number,
  passwordHash: string,
): Promise<void> {
  await query(
    `UPDATE admin_user SET password_hash = $2, must_change_password = false WHERE admin_id = $1`,
    [adminId, passwordHash],
    db,
  );
}

// --- Authenticator app (TOTP) ------------------------------------------------

/** Stores a new secret during set-up. Refused once 2FA is switched on. */
export async function saveTotpSecret(adminId: number, encryptedSecret: string): Promise<boolean> {
  const result = await query(
    `UPDATE admin_user SET totp_secret_encrypted = $2, totp_last_used_step = NULL
     WHERE admin_id = $1 AND NOT two_factor_enabled`,
    [adminId, encryptedSecret],
  );
  return result.rowCount === 1;
}

/** Switches 2FA on, but only for the exact secret the admin just confirmed. */
export async function enableTwoFactor(
  db: Queryable,
  adminId: number,
  encryptedSecret: string,
  usedStep: number,
): Promise<boolean> {
  const result = await query(
    `UPDATE admin_user SET two_factor_enabled = true, totp_last_used_step = $3
     WHERE admin_id = $1 AND NOT two_factor_enabled AND totp_secret_encrypted = $2`,
    [adminId, encryptedSecret, usedStep],
    db,
  );
  return result.rowCount === 1;
}

/** Marks a time step as used. False if that code (or a later one) was already used. */
export async function claimTotpStep(
  db: Queryable,
  adminId: number,
  step: number,
): Promise<boolean> {
  const result = await query(
    `UPDATE admin_user SET totp_last_used_step = $2
     WHERE admin_id = $1 AND (totp_last_used_step IS NULL OR totp_last_used_step < $2)`,
    [adminId, step],
    db,
  );
  return result.rowCount === 1;
}

// --- Backup codes ------------------------------------------------------------

export async function replaceBackupCodes(
  db: Queryable,
  adminId: number,
  codeHashes: string[],
): Promise<void> {
  await query('DELETE FROM admin_backup_code WHERE admin_id = $1', [adminId], db);
  await query(
    `INSERT INTO admin_backup_code (admin_id, code_hash) SELECT $1, unnest($2::text[])`,
    [adminId, codeHashes],
    db,
  );
}

/** Uses up a backup code. False if it doesn't exist or was used before. */
export async function useBackupCode(
  db: Queryable,
  adminId: number,
  codeHash: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE admin_backup_code SET used_at = now()
     WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [adminId, codeHash],
    db,
  );
  return result.rowCount === 1;
}

export async function countUnusedBackupCodes(
  adminId: number,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await query<{ remaining: number }>(
    `SELECT count(*)::int AS remaining FROM admin_backup_code
     WHERE admin_id = $1 AND used_at IS NULL`,
    [adminId],
    db,
  );
  return rows[0]?.remaining ?? 0;
}

// --- Sessions (refresh tokens) -----------------------------------------------

export type RevokeReason =
  | 'rotated'
  | 'signed_out'
  | 'signed_out_everywhere'
  | 'password_changed'
  | 'reuse_detected'
  | 'account_deactivated';

/**
 * Saves a refresh token's hash. A new session lasts `hoursValid` hours; a
 * rotated token keeps its session's original end time (`expiresAt`).
 */
export async function insertRefreshToken(
  db: Queryable,
  token: {
    adminId: number;
    tokenHash: string;
    familyId: string;
    userAgent: string | null;
    expiresAt?: Date;
    hoursValid: number;
  },
): Promise<Date> {
  const { rows } = await query<{ expires_at: Date }>(
    `INSERT INTO refresh_token (user_type, user_id, token_hash, family_id, expires_at, user_agent)
     VALUES ('admin', $1, $2, $3, COALESCE($4::timestamptz, now() + make_interval(hours => $5)), $6)
     RETURNING expires_at`,
    [
      token.adminId,
      token.tokenHash,
      token.familyId,
      token.expiresAt ?? null,
      token.hoursValid,
      token.userAgent,
    ],
    db,
  );
  return rows[0]!.expires_at;
}

export type RefreshTokenRow = {
  token_id: number;
  admin_id: number;
  family_id: string;
  expires_at: Date;
  expired: boolean;
  revoked: boolean;
  revoke_reason: RevokeReason | null;
  revoked_seconds_ago: number | null;
};

/** Finds a token and locks its row until the transaction ends, so two refreshes can't race. */
export async function findRefreshTokenForUpdate(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const { rows } = await query<RefreshTokenRow>(
    `SELECT token_id, user_id AS admin_id, family_id, expires_at,
            expires_at <= now() AS expired,
            revoked_at IS NOT NULL AS revoked,
            revoke_reason,
            extract(epoch FROM now() - revoked_at)::float8 AS revoked_seconds_ago
     FROM refresh_token
     WHERE token_hash = $1 AND user_type = 'admin'
     FOR UPDATE`,
    [tokenHash],
    db,
  );
  return rows[0] ?? null;
}

/** True while the session still has a token that works. */
export async function familyIsActive(db: Queryable, familyId: string): Promise<boolean> {
  const { rows } = await query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM refresh_token
       WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ) AS active`,
    [familyId],
    db,
  );
  return rows[0]?.active ?? false;
}

export async function revokeRefreshToken(
  db: Queryable,
  tokenId: number,
  reason: RevokeReason,
): Promise<void> {
  await query(
    `UPDATE refresh_token SET revoked_at = now(), revoke_reason = $2
     WHERE token_id = $1 AND revoked_at IS NULL`,
    [tokenId, reason],
    db,
  );
}

export async function revokeFamily(
  db: Queryable,
  familyId: string,
  reason: RevokeReason,
): Promise<void> {
  await query(
    `UPDATE refresh_token SET revoked_at = now(), revoke_reason = $2
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
    db,
  );
}

/** Signing out: ends the session the token belongs to. */
export async function revokeFamilyByTokenHash(tokenHash: string): Promise<void> {
  await query(
    `UPDATE refresh_token SET revoked_at = now(), revoke_reason = 'signed_out'
     WHERE revoked_at IS NULL
       AND family_id = (SELECT family_id FROM refresh_token
                        WHERE token_hash = $1 AND user_type = 'admin')`,
    [tokenHash],
  );
}

/**
 * Ends every session the admin has: all refresh tokens stop working, and the
 * new session_version makes every access token already handed out invalid.
 */
export async function endAllSessions(
  db: Queryable,
  adminId: number,
  reason: RevokeReason,
): Promise<AdminAuthRow> {
  await query(
    `UPDATE refresh_token SET revoked_at = now(), revoke_reason = $2
     WHERE user_type = 'admin' AND user_id = $1 AND revoked_at IS NULL`,
    [adminId, reason],
    db,
  );
  const { rows } = await query<AdminAuthRow>(
    `UPDATE admin_user SET session_version = session_version + 1
     WHERE admin_id = $1
     RETURNING ${ADMIN_COLUMNS}`,
    [adminId],
    db,
  );
  return rows[0]!;
}

/** Housekeeping at each sign-in: forget this admin's sessions that ended over a day ago. */
export async function deleteOldRefreshTokens(db: Queryable, adminId: number): Promise<void> {
  await query(
    `DELETE FROM refresh_token
     WHERE user_type = 'admin' AND user_id = $1 AND expires_at < now() - interval '1 day'`,
    [adminId],
    db,
  );
}
