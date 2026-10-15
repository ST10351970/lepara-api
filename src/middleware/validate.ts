import type { RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, ErrorCode, type FieldError, dedupeFields } from '../utils/AppError';
import { fieldsFromZod } from './errorHandler';

/**
 * Checks a request's params, query and body against Zod schemas before the
 * controller runs. Unknown body fields are stripped. All problems are
 * reported at once, one message per field.
 *
 *   router.post('/x', validate({ body: createSchema }), controller)
 *
 * In Express 5 req.query cannot be replaced, so the cleaned values are kept
 * in res.locals.validated; read them with validated(res).
 */

type Part = 'params' | 'query' | 'body';
type Schemas = Partial<Record<Part, ZodType>>;
export type Validated = Partial<Record<Part, unknown>>;

export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const problems: FieldError[] = [];
    const cleaned: Validated = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) cleaned[part] = result.data;
      else problems.push(...fieldsFromZod(result.error));
    }

    if (problems.length > 0) {
      next(
        new AppError(
          400,
          ErrorCode.VALIDATION_ERROR,
          'Please check the highlighted fields.',
          dedupeFields(problems),
        ),
      );
      return;
    }

    res.locals.validated = cleaned;
    if (cleaned.body !== undefined) req.body = cleaned.body;
    next();
  };
}

/** The cleaned params, query and body for this request. */
export function validated<T extends Validated>(res: Response): T {
  return (res.locals.validated ?? {}) as T;
}
