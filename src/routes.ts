import { Router } from 'express';
import { healthRouter } from './modules/health/health.routes';

/** Everything under /api/v1. Each later step mounts its module here. */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
