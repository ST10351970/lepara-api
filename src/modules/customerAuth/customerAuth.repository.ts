import { type Queryable, pool, query } from '../../config/db';
import { CODE_MINUTES, type CodePurpose, MAX_CODE_ATTEMPTS } from './customerAuth.codes';

/**
 * Every query customer accounts need. Values always go in as $1, $2, ...
 * (CUSTOMER_COLUMNS is a fixed list written here, never user input.)
 */

export type CustomerRow = {
  customer_id: number;
  first_name: string;
  last_name: string;
  email: string;
  mobile: string;
  password_hash: string;
  email_verified_at: Date | null;
  two_factor_enabled: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  is_active: boolean;
  deleted_at: Date | null;
  session_version: number;
  last_login_at: Date | null;
  created_at: Date;
};

const CUSTOMER_COLUMNS = `customer_id, first_name, last_name, email, mobile, password_hash,
  email_verified_at, two_factor_enabled, failed_login_count, locked_until, is_active, deleted_at,
  session_version, last_login_at, created_at`;

/** Active, not deleted. Email addresses are stored and compared in lower case. */
export async function findCustomerByEmail(
  email: string,
  db: Queryable = pool,
): Promise<CustomerRow | null> {
  const { rows } = await query<CustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customer
     WHERE lower(email) = lower($1) AND is_active AND deleted_at IS NULL`,
    [email],
    db,
  );
  return rows[0] ?? null;
}

export async function emailInUse(email: string, db: Queryable = pool): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM customer WHERE lower(email) = lower($1)',
    [email],
    db,
  );
  return rows.length > 0;
}

export async function findCustomerById(
  customerId: number,
  db: Queryable = pool,
  { lock = false } = {},
): Promise<CustomerRow | null> {
  const { rows } = await query<CustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customer WHERE customer_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [customerId],
    db,
  );
  return rows[0] ?? null;
}

/** What the check on every customer request needs: small and fast. */
export type CustomerSessionRow = Pick<
  CustomerRow,
  'customer_id' | 'email' | 'is_active' | 'deleted_at' | 'session_version'
>;

export async function findCustomerSession(customerId: number): Promise<CustomerSessionRow | null> {
  const { rows } = await query<CustomerSessionRow>(
    `SELECT customer_id, email, is_active, deleted_at, session_version
     FROM customer WHERE customer_id = $1`,
    [customerId],
  );
  return rows[0] ?? null;
}

export async function insertCustomer(
  db: Queryable,
  values: {
    firstName: string;
    lastName: string;
    email: string;
    mobile: string;
    passwordHash: string;
  },
): Promise<CustomerRow> {
  const { rows } = await query<CustomerRow>(
    `INSERT INTO customer (first_name, last_name, email, mobile, password_hash, terms_accepted_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING ${CUSTOMER_COLUMNS}`,
    [values.firstName, values.lastName, values.email, values.mobile, values.passwordHash],
    db,
  );
  return rows[0]!;
}

export type CustomerChanges = {
  first_name?: string;
  last_name?: string;
  mobile?: string;
  email?: string;
  password_hash?: string;
  two_factor_enabled?: boolean;
};

const CHANGEABLE: Array<keyof CustomerChanges> = [
  'first_name',
  'last_name',
  'mobile',
  'email',
  'password_hash',
  'two_factor_enabled',
];

export async function updateCustomer(
  db: Queryable,
  customerId: number,
  changes: CustomerChanges,
): Promise<CustomerRow> {
  const columns = CHANGEABLE.filter((column) => changes[column] !== undefined);
  if (columns.length === 0) return (await findCustomerById(customerId, db))!;
  const sets = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  const { rows } = await query<CustomerRow>(
    `UPDATE customer SET ${sets}
     WHERE customer_id = $1
     RETURNING ${CUSTOMER_COLUMNS}`,
    [customerId, ...columns.map((column) => changes[column])],
    db,
  );
  return rows[0]!;
}

export async function markEmailVerified(db: Queryable, customerId: number): Promise<void> {
  await query(
    `UPDATE customer SET email_verified_at = COALESCE(email_verified_at, now())
     WHERE customer_id = $1`,
    [customerId],
    db,
  );
}

/**
 * Counts a wrong password or login code. On the last allowed attempt the
 * account is locked and the count starts again. Returns when the lock ends,
 * or null if this attempt did not lock it.
 */
export async function recordFailedAttempt(
  customerId: number,
  maxAttempts: number,
  lockMinutes: number,
): Promise<Date | null> {
  const { rows } = await query<{ locked_until: Date | null }>(
    `UPDATE customer
     SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0
                                   ELSE failed_login_count + 1 END,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3)
                             ELSE locked_until END
     WHERE customer_id = $1
     RETURNING CASE WHEN locked_until > now() THEN locked_until END AS locked_until`,
    [customerId, maxAttempts, lockMinutes],
  );
  return rows[0]?.locked_until ?? null;
}

/** A complete sign-in: clears failed attempts and records the time. */
export async function recordSuccessfulSignIn(
  db: Queryable,
  customerId: number,
): Promise<CustomerRow> {
  const { rows } = await query<CustomerRow>(
    `UPDATE customer SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
     WHERE customer_id = $1
     RETURNING ${CUSTOMER_COLUMNS}`,
    [customerId],
    db,
  );
  return rows[0]!;
}

// --- 6-digit codes -------------------------------------------------------------------------

/** Saves a new code and cancels any older unused ones for the same purpose. */
export async function saveCode(
  db: Queryable,
  values: { customerId: number; purpose: CodePurpose; codeHash: string; newEmail?: string },
): Promise<void> {
  await query(
    `UPDATE verification_code SET used_at = now()
     WHERE customer_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [values.customerId, values.purpose],
    db,
  );
  await query(
    `INSERT INTO verification_code (customer_id, purpose, code_hash, new_email, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [values.customerId, values.purpose, values.codeHash, values.newEmail ?? null, CODE_MINUTES],
    db,
  );
}

export type CodeRow = {
  code_id: number;
  code_hash: string;
  new_email: string | null;
  attempts: number;
};

/** The newest code still usable for this purpose: not used, not expired, tries left. Locked. */
export async function findUsableCode(
  db: Queryable,
  customerId: number,
  purpose: CodePurpose,
): Promise<CodeRow | null> {
  const { rows } = await query<CodeRow>(
    `SELECT code_id, code_hash, new_email, attempts FROM verification_code
     WHERE customer_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       AND attempts < $3
     ORDER BY created_at DESC, code_id DESC
     LIMIT 1
     FOR UPDATE`,
    [customerId, purpose, MAX_CODE_ATTEMPTS],
    db,
  );
  return rows[0] ?? null;
}

/** A wrong try. Returns how many tries are left for this code. */
export async function countWrongCode(db: Queryable, codeId: number): Promise<number> {
  const { rows } = await query<{ attempts: number }>(
    'UPDATE verification_code SET attempts = attempts + 1 WHERE code_id = $1 RETURNING attempts',
    [codeId],
    db,
  );
  return MAX_CODE_ATTEMPTS - (rows[0]?.attempts ?? MAX_CODE_ATTEMPTS);
}

export async function useCode(db: Queryable, codeId: number): Promise<void> {
  await query('UPDATE verification_code SET used_at = now() WHERE code_id = $1', [codeId], db);
}

/** The email address waiting for its code, if a change is in progress. */
export async function findPendingEmail(customerId: number): Promise<string | null> {
  const { rows } = await query<{ new_email: string }>(
    `SELECT new_email FROM verification_code
     WHERE customer_id = $1 AND purpose = 'change_email' AND used_at IS NULL
       AND expires_at > now() AND attempts < $2
     ORDER BY created_at DESC LIMIT 1`,
    [customerId, MAX_CODE_ATTEMPTS],
  );
  return rows[0]?.new_email ?? null;
}

// --- Sessions (refresh tokens) -------------------------------------------------------------

export type RevokeReason =
  | 'rotated'
  | 'signed_out'
  | 'password_changed'
  | 'password_reset'
  | 'reuse_detected'
  | 'account_deactivated';

/** Saves a refresh token's hash, valid for `daysValid` days. */
export async function insertRefreshToken(
  db: Queryable,
  token: {
    customerId: number;
    tokenHash: string;
    familyId: string;
    userAgent: string | null;
    daysValid: number;
  },
): Promise<Date> {
  const { rows } = await query<{ expires_at: Date }>(
    `INSERT INTO refresh_token (user_type, user_id, token_hash, family_id, expires_at, user_agent)
     VALUES ('customer', $1, $2, $3, now() + make_interval(days => $4), $5)
     RETURNING expires_at`,
    [token.customerId, token.tokenHash, token.familyId, token.daysValid, token.userAgent],
    db,
  );
  return rows[0]!.expires_at;
}

export type RefreshTokenRow = {
  token_id: number;
  customer_id: number;
  family_id: string;
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
    `SELECT token_id, user_id AS customer_id, family_id,
            expires_at <= now() AS expired,
            revoked_at IS NOT NULL AS revoked,
            revoke_reason,
            extract(epoch FROM now() - revoked_at)::float8 AS revoked_seconds_ago
     FROM refresh_token
     WHERE token_hash = $1 AND user_type = 'customer'
     FOR UPDATE`,
    [tokenHash],
    db,
  );
  return rows[0] ?? null;
}

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
                        WHERE token_hash = $1 AND user_type = 'customer')`,
    [tokenHash],
  );
}

/**
 * Ends every session the customer has: refresh tokens stop working, and the
 * new session_version makes every access token already handed out invalid.
 */
export async function endAllSessions(
  db: Queryable,
  customerId: number,
  reason: RevokeReason,
): Promise<CustomerRow> {
  await query(
    `UPDATE refresh_token SET revoked_at = now(), revoke_reason = $2
     WHERE user_type = 'customer' AND user_id = $1 AND revoked_at IS NULL`,
    [customerId, reason],
    db,
  );
  const { rows } = await query<CustomerRow>(
    `UPDATE customer SET session_version = session_version + 1
     WHERE customer_id = $1
     RETURNING ${CUSTOMER_COLUMNS}`,
    [customerId],
    db,
  );
  return rows[0]!;
}

/** Housekeeping at each sign-in: forget this customer's sessions that ended over a day ago. */
export async function deleteOldRefreshTokens(db: Queryable, customerId: number): Promise<void> {
  await query(
    `DELETE FROM refresh_token
     WHERE user_type = 'customer' AND user_id = $1 AND expires_at < now() - interval '1 day'`,
    [customerId],
    db,
  );
}

// --- Deleting an account (POPIA) -----------------------------------------------------------

/**
 * Removes the personal details but keeps the row, so the customer's orders
 * stay on record. The email becomes a placeholder that can never be signed
 * in to, which also frees the real address for a new account.
 */
export async function anonymiseCustomer(db: Queryable, customerId: number): Promise<void> {
  await query(
    `UPDATE customer
     SET first_name = 'Deleted', last_name = 'Customer',
         email = 'deleted-' || customer_id || '@deleted.invalid', mobile = '',
         password_hash = '!', two_factor_enabled = false, is_active = false,
         deleted_at = now(), failed_login_count = 0, locked_until = NULL
     WHERE customer_id = $1`,
    [customerId],
    db,
  );
  await query('DELETE FROM verification_code WHERE customer_id = $1', [customerId], db);
  await query('DELETE FROM device_token WHERE customer_id = $1', [customerId], db);
}

/** After a password reset: a fresh start, with no failed attempts or lock. */
export async function clearLock(db: Queryable, customerId: number): Promise<void> {
  await query(
    'UPDATE customer SET failed_login_count = 0, locked_until = NULL WHERE customer_id = $1',
    [customerId],
    db,
  );
}
