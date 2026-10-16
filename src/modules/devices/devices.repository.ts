import { type Queryable, pool, query } from '../../config/db';

/**
 * Push notification tokens, one row per phone. A token can be linked to the
 * customer signed in on that phone, so order updates reach only their devices.
 */

/** Saves a new token, or updates the platform, customer and last-seen time of a known one. */
export async function saveDevice(
  token: string,
  platform: string,
  customerId: number | null,
): Promise<void> {
  await query(
    `INSERT INTO device_token (token, platform, customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE
       SET platform = EXCLUDED.platform, customer_id = EXCLUDED.customer_id, last_seen_at = now()`,
    [token, platform, customerId],
  );
}

export async function deleteDevice(token: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM device_token WHERE token = $1', [token]);
  return (rowCount ?? 0) > 0;
}

/**
 * FCM stops accepting a token after about 270 days without the app opening;
 * the app registers again on every start, so older rows are dead.
 */
export const STALE_AFTER_DAYS = 270;

/** Every device that can receive news (stale tokens are removed first). */
export async function allDeviceTokens(db: Queryable = pool): Promise<string[]> {
  await query(
    `DELETE FROM device_token WHERE last_seen_at < now() - make_interval(days => $1)`,
    [STALE_AFTER_DAYS],
    db,
  );
  const { rows } = await query<{ token: string }>(
    'SELECT token FROM device_token ORDER BY device_token_id',
    [],
    db,
  );
  return rows.map((row) => row.token);
}

/** The devices where this customer is signed in. */
export async function customerDeviceTokens(
  customerId: number,
  db: Queryable = pool,
): Promise<string[]> {
  const { rows } = await query<{ token: string }>(
    `SELECT token FROM device_token
     WHERE customer_id = $1 AND last_seen_at >= now() - make_interval(days => $2)
     ORDER BY device_token_id`,
    [customerId, STALE_AFTER_DAYS],
    db,
  );
  return rows.map((row) => row.token);
}

/** Removes tokens FCM said are no longer valid. */
export async function deleteTokens(tokens: string[], db: Queryable = pool): Promise<number> {
  if (tokens.length === 0) return 0;
  const { rowCount } = await query(
    'DELETE FROM device_token WHERE token = ANY($1::text[])',
    [tokens],
    db,
  );
  return rowCount ?? 0;
}
