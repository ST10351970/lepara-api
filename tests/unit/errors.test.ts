import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toAppError } from '../../src/middleware/errorHandler';
import { AppError, errors } from '../../src/utils/AppError';
import { isRetryableTransactionError, mapDatabaseError } from '../../src/utils/pgErrors';

/** What PostgreSQL errors look like when they reach the API through `pg`. */
const pgError = (code: string, constraint?: string) => ({
  code,
  severity: 'ERROR',
  constraint,
  message: 'db',
});

describe('mapDatabaseError', () => {
  const cases: Array<[string, number, RegExp]> = [
    ['23505', 409, /already been submitted/],
    ['23503', 409, /linked record/],
    ['23001', 409, /linked record/],
    ['23514', 400, /isn't allowed/],
    ['23502', 400, /required fields/],
    ['22P02', 400, /couldn't read/],
    ['22001', 400, /too long/],
    ['22003', 400, /too large/],
    ['22007', 400, /valid date/],
    ['40001', 503, /try again/],
    ['40P01', 503, /try again/],
    ['57014', 503, /too long to respond/],
    ['08006', 503, /can't reach the server/],
    ['57P01', 503, /can't reach the server/],
  ];

  for (const [code, status, message] of cases) {
    it(`maps PostgreSQL ${code} to ${status}`, () => {
      const mapped = mapDatabaseError(pgError(code));
      expect(mapped).toBeInstanceOf(AppError);
      expect(mapped?.status).toBe(status);
      expect(mapped?.message).toMatch(message);
    });
  }

  it('treats network failures as the database being unreachable', () => {
    expect(
      mapDatabaseError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))?.status,
    ).toBe(503);
    expect(mapDatabaseError(new Error('Connection terminated unexpectedly'))?.status).toBe(503);
    expect(mapDatabaseError(new Error('timeout exceeded when trying to connect'))?.status).toBe(
      503,
    );
  });

  it('leaves unrelated errors alone', () => {
    expect(mapDatabaseError(new Error('something else'))).toBeNull();
    expect(mapDatabaseError(pgError('42P01'))).toBeNull();
    expect(mapDatabaseError(null)).toBeNull();
    expect(mapDatabaseError('text')).toBeNull();
  });

  it('retries only transaction conflicts and deadlocks', () => {
    expect(isRetryableTransactionError(pgError('40001'))).toBe(true);
    expect(isRetryableTransactionError(pgError('40P01'))).toBe(true);
    expect(isRetryableTransactionError(pgError('23505'))).toBe(false);
  });
});

describe('toAppError', () => {
  it('keeps errors the API threw on purpose', () => {
    const original = errors.conflict('An account with this email already exists.');
    expect(toAppError(original)).toBe(original);
  });

  it('turns Zod errors into one message per field', () => {
    const schema = z.object({ email: z.string().min(3, 'Too short'), name: z.string() });
    const result = schema.safeParse({ email: 'a', name: 5 });
    expect(result.success).toBe(false);
    const mapped = toAppError(result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('VALIDATION_ERROR');
    expect(mapped.fields?.map((f) => f.field)).toEqual(['email', 'name']);
    expect(mapped.fields?.[0]?.message).toBe('Too short');
  });

  it('turns body-parser errors into friendly replies', () => {
    expect(toAppError({ type: 'entity.parse.failed' })).toMatchObject({
      status: 400,
      code: 'INVALID_JSON',
    });
    expect(toAppError({ type: 'entity.too.large' })).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(toAppError({ type: 'charset.unsupported' })).toMatchObject({ status: 415 });
  });

  it('hides anything unexpected behind a generic 500', () => {
    const mapped = toAppError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).not.toContain('undefined');
  });
});
