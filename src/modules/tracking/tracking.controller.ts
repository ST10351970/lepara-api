import type { Request, Response } from 'express';
import { validated } from '../../middleware/validate';
import { ok } from '../../utils/respond';
import type { TrackInput } from './tracking.schemas';
import { track } from './tracking.service';

/** POST /track */
export async function trackSubmission(_req: Request, res: Response): Promise<void> {
  const { body } = validated<{ body: TrackInput }>(res);
  ok(res, await track(body));
}
