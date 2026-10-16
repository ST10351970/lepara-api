import { z } from 'zod';
import { pagination, requiredText, searchText } from '../../schemas/common';

/** What the announcement endpoints accept. Messages appear on the website's forms. */

const title = requiredText('Please enter a title.')
  .trim()
  .min(5, 'Please enter a title of at least 5 characters.')
  .max(120, 'Please keep the title under 120 characters.');

const body = requiredText('Please write the announcement.')
  .trim()
  .min(10, 'Please write at least 10 characters.')
  .max(2000, 'Please keep the announcement under 2,000 characters.');

/** GET /announcements?page=&pageSize= */
export const publicListQuery = pagination;
export type PublicListQuery = z.infer<typeof publicListQuery>;

/** GET /admin/announcements?status=active|inactive|all&search= */
export const adminListQuery = pagination.extend({
  status: z.enum(['active', 'inactive', 'all']).catch('all'),
  search: searchText,
});
export type AdminListQuery = z.infer<typeof adminListQuery>;

/** A new announcement is published straight away (Task 1 has no drafts for these). */
export const createAnnouncementSchema = z.object({ title, body });
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const updateAnnouncementSchema = z
  .object({ title: title.optional(), body: body.optional() })
  .refine(
    (changes) => changes.title !== undefined || changes.body !== undefined,
    'Please change at least one detail.',
  );
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

/** PATCH /admin/announcements/:id/active { isActive } hides or shows it again. */
export const activeSchema = z.object({
  isActive: z.boolean({
    error: 'Please choose whether the announcement is shown (true or false).',
  }),
});
export type ActiveInput = z.infer<typeof activeSchema>;
