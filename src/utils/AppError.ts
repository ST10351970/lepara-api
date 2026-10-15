/**
 * The one error type the API throws on purpose. The error handler turns it
 * into the standard error envelope, so every failure looks the same to the
 * mobile app and the website.
 */

export type FieldError = { field: string; message: string };

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: FieldError[];

  constructor(status: number, code: ErrorCode, message: string, fields?: FieldError[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (fields && fields.length > 0) this.fields = fields;
  }
}

/** Shortcuts with plain-language default messages. */
export const errors = {
  validation: (fields: FieldError[], message = 'Please check the highlighted fields.') =>
    new AppError(400, ErrorCode.VALIDATION_ERROR, message, fields),
  badRequest: (message: string) => new AppError(400, ErrorCode.VALIDATION_ERROR, message),
  unauthorized: (message = 'Please sign in to continue.') =>
    new AppError(401, ErrorCode.UNAUTHORIZED, message),
  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError(403, ErrorCode.FORBIDDEN, message),
  notFound: (message = "We couldn't find that item.") =>
    new AppError(404, ErrorCode.NOT_FOUND, message),
  conflict: (message: string) => new AppError(409, ErrorCode.CONFLICT, message),
  locked: (message = 'Your account is locked for 15 minutes after too many attempts.') =>
    new AppError(423, ErrorCode.ACCOUNT_LOCKED, message),
  tooManyRequests: (message = 'Too many attempts. Please wait a few minutes and try again.') =>
    new AppError(429, ErrorCode.RATE_LIMITED, message),
  unavailable: (message = "We can't reach the server right now. Please try again in a minute.") =>
    new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message),
};

/** Keeps the first message per field, so the app shows one message under each input. */
export function dedupeFields(fields: FieldError[]): FieldError[] {
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.field) ? false : (seen.add(f.field), true)));
}
