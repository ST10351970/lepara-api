import type { Request, Response } from 'express';
import { pingDatabase } from './health.repository';
import { errors } from '../../utils/AppError';
import { ok } from '../../utils/respond';

/** GET /api/v1/health: used by the host to check the API and database are up. */
export async function getHealth(req: Request, res: Response): Promise<void> {
  let databaseUp = false;
  try {
    databaseUp = await pingDatabase();
  } catch (error) {
    req.log?.error({ err: error }, 'Health check could not reach the database');
  }
  if (!databaseUp) throw errors.unavailable();

  ok(res, {
    status: 'ok',
    database: 'up',
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
}
