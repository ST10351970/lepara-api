import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../utils/AppError';

/** Any path no route matched. */
export const notFound: RequestHandler = (_req, _res, next) => {
  next(
    new AppError(404, ErrorCode.NOT_FOUND, "This address doesn't exist. Please check the link."),
  );
};
