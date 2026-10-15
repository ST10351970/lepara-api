import { Router } from 'express';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { idParam } from '../../schemas/common';
import * as controller from './initiatives.controller';
import {
  adminListQuery,
  createInitiativeSchema,
  createTaskSchema,
  createTypeSchema,
  publicListQuery,
  statusChangeSchema,
  taskParams,
  updateInitiativeSchema,
  updateTaskSchema,
  updateTypeSchema,
} from './initiatives.schemas';

// --- Public: /api/v1/initiatives and /api/v1/initiative-types --------------------

export const initiativesRouter = Router();
initiativesRouter.get('/', validate({ query: publicListQuery }), controller.listPublic);
initiativesRouter.get('/:id', validate({ params: idParam }), controller.getPublic);
initiativesRouter.get('/:id/tasks', validate({ params: idParam }), controller.getPublicTasks);

export const initiativeTypesRouter = Router();
initiativeTypesRouter.get('/', controller.listPublicTypes);

// --- Admin: /api/v1/admin/initiatives and /api/v1/admin/initiative-types -----------
// Mounted behind authenticateAdmin: any signed-in admin (staff or super admin).

export const adminInitiativesRouter = Router();
adminInitiativesRouter.get('/', validate({ query: adminListQuery }), controller.listAdmin);
adminInitiativesRouter.post('/', validate({ body: createInitiativeSchema }), controller.create);
adminInitiativesRouter.get('/:id', validate({ params: idParam }), controller.getAdmin);
adminInitiativesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateInitiativeSchema }),
  controller.update,
);
adminInitiativesRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: statusChangeSchema }),
  controller.changeStatus,
);
// The photo is checked before anything else: size, then real file type.
adminInitiativesRouter.post(
  '/:id/image',
  validate({ params: idParam }),
  imageUpload,
  controller.uploadImage,
);

adminInitiativesRouter.get('/:id/tasks', validate({ params: idParam }), controller.listTasks);
adminInitiativesRouter.post(
  '/:id/tasks',
  validate({ params: idParam, body: createTaskSchema }),
  controller.createTask,
);
adminInitiativesRouter.patch(
  '/:id/tasks/:taskId',
  validate({ params: taskParams, body: updateTaskSchema }),
  controller.updateTask,
);
adminInitiativesRouter.delete(
  '/:id/tasks/:taskId',
  validate({ params: taskParams }),
  controller.deleteTask,
);

export const adminInitiativeTypesRouter = Router();
adminInitiativeTypesRouter.get('/', controller.listTypes);
adminInitiativeTypesRouter.post('/', validate({ body: createTypeSchema }), controller.createType);
adminInitiativeTypesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateTypeSchema }),
  controller.updateType,
);
