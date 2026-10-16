import type { RequestHandler, Response } from 'express';
import { findAdminSession, type AdminRole } from '../modules/adminAuth/adminAuth.repository';
import { readAccessToken } from '../modules/adminAuth/adminAuth.tokens';
import { findCustomerSession } from '../modules/customerAuth/customerAuth.repository';
import {
  readAccessToken as readCustomerAccessToken,
} from '../modules/customerAuth/customerAuth.tokens';
import { AppError, ErrorCode, errors } from '../utils/AppError';

/**
 * Admin routes: the request must carry "Authorization: Bearer <access token>".
 * Besides checking the token's signature and expiry, the admin is looked up,
 * so a deactivated admin or an ended session (password changed, signed out
 * everywhere) is refused straight away rather than when the token expires.
 * Customer routes use authenticateCustomer below, with their own tokens.
 */

export type AdminPrincipal = {
  adminId: number;
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
};

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export const authenticateAdmin: RequestHandler = async (req, res, next) => {
  const match = BEARER_PATTERN.exec(req.headers.authorization ?? '');
  if (!match) throw errors.unauthorized();

  const claims = readAccessToken(match[1]!);
  const admin = await findAdminSession(claims.adminId);
  if (!admin || !admin.is_active || admin.session_version !== claims.sessionVersion) {
    throw errors.unauthorized('Your session has ended. Please sign in again.');
  }

  res.locals.admin = {
    adminId: admin.admin_id,
    username: admin.username,
    role: admin.role,
    mustChangePassword: admin.must_change_password,
  } satisfies AdminPrincipal;
  next();
};

/** The signed-in admin. Only call this on routes behind authenticateAdmin. */
export function currentAdmin(res: Response): AdminPrincipal {
  const admin = res.locals.admin as AdminPrincipal | undefined;
  if (!admin) throw errors.unauthorized();
  return admin;
}

/**
 * A new admin's temporary password must be replaced first. Everything after
 * this middleware is closed until then; /admin/me and the password change
 * are mounted before it.
 */
export const requirePasswordChanged: RequestHandler = (_req, res, next) => {
  if (currentAdmin(res).mustChangePassword) {
    throw new AppError(
      403,
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
      'Please change your temporary password before continuing.',
    );
  }
  next();
};

// --- Customers ------------------------------------------------------------------------------

export type CustomerPrincipal = { customerId: number; email: string };

/**
 * Customer routes (/me, orders): the request must carry a customer access
 * token. Admin tokens are signed with a different secret, so they never work
 * here, and customer tokens never work on admin routes.
 */
export const authenticateCustomer: RequestHandler = async (req, res, next) => {
  const match = BEARER_PATTERN.exec(req.headers.authorization ?? '');
  if (!match) throw errors.unauthorized();

  const claims = readCustomerAccessToken(match[1]!);
  const customer = await findCustomerSession(claims.customerId);
  if (
    !customer ||
    !customer.is_active ||
    customer.deleted_at !== null ||
    customer.session_version !== claims.sessionVersion
  ) {
    throw errors.unauthorized('Your session has ended. Please sign in again.');
  }

  res.locals.customer = {
    customerId: customer.customer_id,
    email: customer.email,
  } satisfies CustomerPrincipal;
  next();
};

/** The signed-in customer. Only call this on routes behind authenticateCustomer. */
export function currentCustomer(res: Response): CustomerPrincipal {
  const customer = res.locals.customer as CustomerPrincipal | undefined;
  if (!customer) throw errors.unauthorized();
  return customer;
}
