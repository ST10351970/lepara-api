import type { RequestHandler } from 'express';
import { logger } from '../utils/logger';
import { created } from '../utils/respond';

/**
 * A spam trap for the public forms. The website adds a field called "website"
 * that people never see (hidden with CSS); simple bots fill in every field.
 * If it has anything in it, the bot gets a normal-looking success reply, but
 * nothing is saved and no email is sent, so it has no reason to try again.
 *
 * The mobile app doesn't need the field: leaving it out is the same as empty.
 */
export const HONEYPOT_FIELD = 'website';

export function honeypot(pretendReply: () => unknown): RequestHandler {
  return (req, res, next) => {
    const body: unknown = req.body;
    const trap =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)[HONEYPOT_FIELD]
        : undefined;
    const filledIn =
      trap !== undefined && trap !== null && !(typeof trap === 'string' && trap.trim() === '');
    if (!filledIn) {
      next();
      return;
    }
    logger.info({ path: req.originalUrl.split('?')[0] }, 'Spam trap filled in; nothing saved');
    created(res, pretendReply());
  };
}
