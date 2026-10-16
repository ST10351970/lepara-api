import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError, ErrorCode } from '../utils/AppError';

/**
 * Limits on how often one IP address can call an endpoint. The counts live
 * in memory, which is fine for a single API instance.
 */

type LimiterOptions = {
  windowMinutes: number;
  limit: number;
  message: string;
  /** Count only failed requests (status 400 and above), e.g. wrong tracking details. */
  onlyCountFailures?: boolean;
  /** Requests that never count, e.g. the host's health checks. */
  skip?: (req: Request) => boolean;
};

export function createLimiter({
  windowMinutes,
  limit,
  message,
  onlyCountFailures = false,
  skip,
}: LimiterOptions) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: onlyCountFailures,
    ...(skip ? { skip } : {}),
    handler: (_req, _res, next) => {
      next(new AppError(429, ErrorCode.RATE_LIMITED, message));
    },
  });
}

export const limiters = {
  /**
   * Every request, as a ceiling against floods: on average one request a second
   * per address. Generous because a school or office shares one address, and
   * an admin's dashboard page makes several requests. Health checks don't count,
   * so the host's checks can never be refused.
   */
  global: createLimiter({
    windowMinutes: 15,
    limit: 900,
    skip: (req) => req.path === '/api/v1/health',
    message: 'You are sending requests too quickly. Please wait a few minutes and try again.',
  }),
  /** Admin and customer sign-in. */
  login: createLimiter({
    windowMinutes: 15,
    limit: 10,
    message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
  }),
  /** Entering 6-digit codes and requesting new ones. */
  codeEntry: createLimiter({
    windowMinutes: 15,
    limit: 10,
    message: 'Too many code attempts. Please wait 15 minutes and request a new code.',
  }),
  /** Volunteer applications, donation pledges, assistance requests, enquiries. */
  publicForms: createLimiter({
    windowMinutes: 10,
    limit: 5,
    message: 'You have sent several forms in a short time. Please wait 10 minutes and try again.',
  }),
  /** Reference-number tracking: only wrong attempts count. */
  tracking: createLimiter({
    windowMinutes: 15,
    limit: 5,
    onlyCountFailures: true,
    message: 'Too many attempts. Please wait 15 minutes and try again.',
  }),
};
