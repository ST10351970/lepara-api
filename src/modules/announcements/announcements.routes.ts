import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './announcements.controller';
import {
  activeSchema,
  adminListQuery,
  createAnnouncementSchema,
  publicListQuery,
  updateAnnouncementSchema,
} from './announcements.schemas';

/** /api/v1/announcements: the News screen. No sign-in. */
export const announcementsRouter = Router();
announcementsRouter.get('/', validate({ query: publicListQuery }), controller.listPublic);

/** /api/v1/admin/announcements: mounted behind authenticateAdmin (staff or super admin). */
export const adminAnnouncementsRouter = Router();
adminAnnouncementsRouter.get('/', validate({ query: adminListQuery }), controller.listAdmin);
adminAnnouncementsRouter.post('/', validate({ body: createAnnouncementSchema }), controller.create);
adminAnnouncementsRouter.get('/:id', validate({ params: idParam }), controller.getAdmin);
adminAnnouncementsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateAnnouncementSchema }),
  controller.update,
);
adminAnnouncementsRouter.patch(
  '/:id/active',
  validate({ params: idParam, body: activeSchema }),
  controller.setActive,
);
