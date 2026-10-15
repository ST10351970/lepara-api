import { AppError, ErrorCode } from './AppError';

/**
 * Turns PostgreSQL and connection errors into friendly replies.
 * This is the safety net: services should catch the cases they expect
 * (for example a duplicate email) and give a more specific message.
 * Codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EAFNOSUPPORT', // Windows: "localhost" tried on IPv6 as well as IPv4
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P01', // admin shutdown
  '57P02', // crash shutdown
  '57P03', // cannot connect now
  '53300', // too many connections
]);

const CONNECTION_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection refused/i,
];

type CodedError = { code: string; severity?: unknown; constraint?: unknown };

function hasCode(error: unknown): error is CodedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** A real PostgreSQL server error: five-character SQLSTATE plus a severity. */
export function isPgError(error: unknown): error is CodedError & { severity: string } {
  return (
    hasCode(error) &&
    /^[0-9A-Z]{5}$/.test(error.code) &&
    typeof (error as { severity?: unknown }).severity === 'string'
  );
}

/** The constraint name PostgreSQL reported, if any. */
export function constraintOf(error: unknown): string | undefined {
  if (!isPgError(error)) return undefined;
  return typeof error.constraint === 'string' ? error.constraint : undefined;
}

const unavailable = (message: string) => new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message);
const invalid = (message: string) => new AppError(400, ErrorCode.VALIDATION_ERROR, message);

export function mapDatabaseError(error: unknown): AppError | null {
  if (error instanceof Error && !hasCode(error)) {
    if (CONNECTION_MESSAGES.some((pattern) => pattern.test(error.message))) {
      return unavailable("We can't reach the server right now. Please try again in a minute.");
    }
    return null;
  }
  if (!hasCode(error)) return null;

  if (CONNECTION_CODES.has(error.code) || (isPgError(error) && error.code.startsWith('08'))) {
    return unavailable("We can't reach the server right now. Please try again in a minute.");
  }
  if (!isPgError(error)) return null;

  switch (error.code) {
    case '23505':
      return new AppError(409, ErrorCode.CONFLICT, 'This has already been submitted.');
    case '23503': // foreign_key_violation
    case '23001': // restrict_violation: PostgreSQL 18+ uses this for ON DELETE RESTRICT
      return new AppError(
        409,
        ErrorCode.CONFLICT,
        'This change conflicts with a linked record. Please refresh and try again.',
      );
    case '23514':
      return invalid("One of the values isn't allowed. Please check and try again.");
    case '23502':
      return invalid('Please fill in all required fields.');
    case '22P02':
      return invalid("We couldn't read one of the values.");
    case '22001':
      return invalid('One of the values is too long.');
    case '22003':
      return invalid('One of the numbers is too large.');
    case '22007':
    case '22008':
      return invalid('Please enter a valid date.');
    case '40001':
    case '40P01':
      return unavailable('Something went wrong. Please try again.');
    case '57014':
      return unavailable('The server took too long to respond. Please try again.');
    default:
      return null;
  }
}

/** Transaction conflicts that are safe to retry once. */
export function isRetryableTransactionError(error: unknown): boolean {
  return isPgError(error) && (error.code === '40001' || error.code === '40P01');
}
