import type { Request, Response } from 'express';
import { customerIdOrNull } from '../../middleware/authenticate';
import { validated } from '../../middleware/validate';
import { ok } from '../../utils/respond';
import * as repo from './devices.repository';
import type { DeviceTokenParams, RegisterDeviceInput } from './devices.schemas';

/**
 * POST /devices: the app calls this on every start (and after signing in or out).
 * Signed in, the phone is linked to the customer for order updates; called
 * without a sign-in, the link is removed, so a signed-out phone gets news only.
 */
export async function register(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: RegisterDeviceInput }>(res);
  const customerId = customerIdOrNull(res);
  await repo.saveDevice(body.token, body.platform, customerId);
  ok(res, { registered: true, linkedToAccount: customerId !== null });
}

/** DELETE /devices/:token: notifications switched off on this phone. */
export async function remove(_req: Request, res: Response): Promise<void> {
  const { params } = validated<{ params: DeviceTokenParams }>(res);
  ok(res, { removed: await repo.deleteDevice(params.token) });
}
