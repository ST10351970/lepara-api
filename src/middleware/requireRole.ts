import type { RequestHandler } from 'express';
import type { AdminRole } from '../modules/adminAuth/adminAuth.repository';
import { errors } from '../utils/AppError';
import { currentAdmin } from './authenticate';

/**
 * Only lets the listed roles through, for example admin management:
 *   router.post('/', requireRole('super_admin'), createAdmin)
 * Use after authenticateAdmin.
 */
export function requireRole(...roles: AdminRole[]): RequestHandler {
  return (_req, res, next) => {
    if (!roles.includes(currentAdmin(res).role)) {
      throw errors.forbidden();
    }
    next();
  };
}
