import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type FieldError, dedupeFields } from '../utils/AppError';
import { constraintOf, mapDatabaseError } from '../utils/pgErrors';

/**
 * The single place where errors become responses. Every failure, from a bad
 * form field to a database outage, ends up here and leaves as the same
 * envelope: { success: false, error: { code, message, fields?, requestId } }.
 */

export function fieldsFromZod(error: ZodError): FieldError[] {
  return dedupeFields(
    error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || 'request',
      message: issue.message,
    })),
  );
}

function mapBodyParserError(error: unknown): AppError | null {
  const type = (error as { type?: unknown } | null)?.type;
  switch (type) {
    case 'entity.parse.failed':
      return new AppError(
        400,
        ErrorCode.INVALID_JSON,
        "We couldn't read that request. Please try again.",
      );
    case 'entity.too.large':
      return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'That request is too large.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError(
        415,
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        'That kind of request is not supported.',
      );
    case 'request.aborted':
      return new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'The request was interrupted. Please try again.',
      );
    default:
      return null;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Please check the highlighted fields.',
      fieldsFromZod(error),
    );
  }
  return (
    mapBodyParserError(error) ??
    mapDatabaseError(error) ??
    new AppError(
      500,
      ErrorCode.INTERNAL_ERROR,
      'Something went wrong on our side. Please try again.',
    )
  );
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = toAppError(error);
  const requestId = req.id === undefined ? undefined : String(req.id);

  if (appError.status >= 500) {
    // Full detail for us; a generic message for the user.
    req.log?.error({ err: error, requestId }, 'Request failed');
  } else {
    // No error object here: database errors can carry submitted values (POPIA).
    req.log?.warn(
      { code: appError.code, status: appError.status, constraint: constraintOf(error), requestId },
      appError.message,
    );
  }

  res.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.fields ? { fields: appError.fields } : {}),
      ...(requestId ? { requestId } : {}),
    },
  });
};
