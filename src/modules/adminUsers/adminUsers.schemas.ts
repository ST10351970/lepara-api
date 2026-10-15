import { z } from 'zod';
import {
  emailAddress,
  pagination,
  personName,
  requiredText,
  searchText,
} from '../../schemas/common';

/** What the admin management endpoints accept. Messages appear on the website's forms. */

export const ADMIN_ROLES = ['super_admin', 'staff'] as const;

const username = requiredText('Please enter a username.')
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9._-]{3,50}$/,
    'Usernames are 3 to 50 characters: letters, numbers, dots, dashes or underscores.',
  );

const role = z.enum(ADMIN_ROLES, { error: 'Please choose a role: super admin or staff.' });

/** ?status=active|inactive|all&search=&page=&pageSize= */
export const listAdminsQuery = pagination.extend({
  status: z.enum(['active', 'inactive', 'all']).catch('all'),
  search: searchText,
});
export type ListAdminsQuery = z.infer<typeof listAdminsQuery>;

/** A new admin. The API makes up the temporary password, so the form has no password field. */
export const createAdminSchema = z.object({
  username,
  fullName: personName('the full name', 150),
  email: emailAddress,
  role: role.default('staff'),
});
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

/** Any of these can change. The username can't, because it is how the admin signs in. */
export const updateAdminSchema = z
  .object({
    fullName: personName('the full name', 150).optional(),
    email: emailAddress.optional(),
    role: role.optional(),
    isActive: z.boolean({ error: 'Please choose active or inactive.' }).optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Please change at least one detail.',
  );
export type UpdateAdminInput = z.infer<typeof updateAdminSchema>;
