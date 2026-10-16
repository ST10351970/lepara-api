import { Router } from 'express';
import { optionalCustomer } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as controller from './devices.controller';
import { deviceTokenParams, registerDeviceSchema } from './devices.schemas';

/** /api/v1/devices: push notification tokens. Signed in or not. */
export const devicesRouter = Router();
devicesRouter.post(
  '/',
  optionalCustomer,
  validate({ body: registerDeviceSchema }),
  controller.register,
);
devicesRouter.delete('/:token', validate({ params: deviceTokenParams }), controller.remove);
