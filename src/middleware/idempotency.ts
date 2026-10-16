import type { RequestHandler, Response } from 'express';
import { type Queryable, pool, query } from '../config/db';
import { AppError, ErrorCode, errors } from '../utils/AppError';
import { sha256Hex } from '../utils/crypto';
import { currentCustomer } from './authenticate';

/**
 * Stops a double tap on "Place order" (or a retry after a dropped connection)
 * from creating two orders.
 *
 * The app makes a new random UUID for each order it means to place and sends it
 * as the Idempotency-Key header. If the same customer sends the same key again
 * within 24 hours, the API replies with the response it stored the first time
 * instead of doing the work again. Only successful responses are stored: if the
 * first try failed (for example, an item sold out), nothing was saved and the
 * same key can be used again.
 *
 * Two parts:
 *  - this middleware, after validation: checks the header and replays a stored
 *    response straight away;
 *  - claimIdempotencyKey(), inside the order's transaction: claims the key. If
 *    the twin request is still running, the database makes this one wait until
 *    the twin finishes, then the stored response is returned. So even two taps
 *    at the same instant give one order.
 */

export const KEY_LIFETIME_HOURS = 24;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdempotencyClaim = {
  customerId: number;
  key: string;
  endpoint: string;
  requestHash: string;
};

export type StoredResponse = { status: number; body: unknown };

type KeyRow = {
  endpoint: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
};

/** JSON with object keys sorted, so the same request always gives the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const fields = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A fingerprint of the cleaned request body. */
export function requestHashOf(body: unknown): string {
  return sha256Hex(stableJson(body ?? {}));
}

const reusedKey = () =>
  new AppError(
    422,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different order. Send a new key for a new order.',
  );

/** Checks a stored row against this request: the same request gets its reply back. */
function storedReply(row: KeyRow, claim: IdempotencyClaim): StoredResponse | null {
  if (row.endpoint !== claim.endpoint || row.request_hash !== claim.requestHash) throw reusedKey();
  if (row.response_status === null) return null;
  return { status: row.response_status, body: row.response_body };
}

async function findKey(db: Queryable, claim: IdempotencyClaim): Promise<KeyRow | null> {
  const { rows } = await query<KeyRow>(
    `SELECT endpoint, request_hash, response_status, response_body
     FROM idempotency_key
     WHERE customer_id = $1 AND idempotency_key = $2
       AND created_at > now() - make_interval(hours => $3)`,
    [claim.customerId, claim.key, KEY_LIFETIME_HOURS],
    db,
  );
  return rows[0] ?? null;
}

/** Sends a stored reply exactly as the first one was sent. */
export function replay(res: Response, stored: StoredResponse): void {
  res.set('Idempotent-Replayed', 'true');
  res.status(stored.status).json({ success: true, data: stored.body });
}

/**
 * Requires an Idempotency-Key header on a signed-in customer's request.
 * Put it after authenticateCustomer and validate(). The claim is left in
 * res.locals.idempotency for the service; read it with idempotencyClaim(res).
 */
export function requireIdempotencyKey(endpoint: string): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('Idempotency-Key')?.trim();
    if (!header) {
      throw errors.badRequest(
        'Please send an Idempotency-Key header: a new UUID for each order you place.',
      );
    }
    if (!UUID_PATTERN.test(header)) {
      throw errors.badRequest(
        'The Idempotency-Key header must be a UUID, ' +
          'for example 3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b.',
      );
    }
    const claim: IdempotencyClaim = {
      customerId: currentCustomer(res).customerId,
      key: header.toLowerCase(),
      endpoint,
      requestHash: requestHashOf(req.body),
    };
    const row = await findKey(pool, claim);
    const stored = row ? storedReply(row, claim) : null;
    if (stored) {
      replay(res, stored);
      return;
    }
    res.locals.idempotency = claim;
    next();
  };
}

/** The claim made by requireIdempotencyKey. */
export function idempotencyClaim(res: Response): IdempotencyClaim {
  const claim = res.locals.idempotency as IdempotencyClaim | undefined;
  if (!claim) throw new Error('requireIdempotencyKey must run before this handler.');
  return claim;
}

/**
 * Inside the transaction, before doing the work: claims the key. Returns null
 * when this request may go ahead, or the stored reply when the same request
 * already finished (it may have finished while this one waited).
 */
export async function claimIdempotencyKey(
  db: Queryable,
  claim: IdempotencyClaim,
): Promise<StoredResponse | null> {
  // Keys older than 24 hours have expired and may be used again.
  await query(
    `DELETE FROM idempotency_key
     WHERE customer_id = $1 AND created_at <= now() - make_interval(hours => $2)`,
    [claim.customerId, KEY_LIFETIME_HOURS],
    db,
  );
  const inserted = await query(
    `INSERT INTO idempotency_key (customer_id, idempotency_key, endpoint, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [claim.customerId, claim.key, claim.endpoint, claim.requestHash],
    db,
  );
  if (inserted.rows.length === 1) return null;

  const row = await findKey(db, claim);
  const stored = row ? storedReply(row, claim) : null;
  if (!stored) {
    throw errors.conflict(
      'Your order is still being placed. Please wait a moment and check again.',
    );
  }
  return stored;
}

/** Inside the same transaction, after the work: keeps the reply for repeats. */
export async function saveIdempotentResponse(
  db: Queryable,
  claim: IdempotencyClaim,
  stored: StoredResponse,
): Promise<void> {
  await query(
    `UPDATE idempotency_key SET response_status = $3, response_body = $4
     WHERE customer_id = $1 AND idempotency_key = $2`,
    [claim.customerId, claim.key, stored.status, JSON.stringify(stored.body)],
    db,
  );
}
