import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { limiters } from './middleware/rateLimiters';
import { apiRouter } from './routes';
import { logger } from './utils/logger';
import { ok } from './utils/respond';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Builds the Express app. Kept separate from server.ts so tests can call the
 * app directly without opening a port.
 */
export function createApp() {
  const app = express();

  // Behind Azure App Service or Render, the real client IP is in X-Forwarded-For.
  app.set('trust proxy', env.TRUST_PROXY);

  // 1. Request ID and logging first, so every response, even an error, has an ID.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        // The path only: query strings can hold personal details.
        req: (req) => ({ id: req.id, method: req.method, path: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => String(req.url).startsWith('/api/v1/health') },
    }),
  );

  // 2. Security headers.
  app.use(helmet());

  // 3. Browsers may call the API only from the website's address. The mobile
  //    app sends no Origin header, so CORS does not affect it.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );

  // 4. JSON bodies, at most 100 KB, and cookies (only the admin sign-in cookie is used).
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // 5. A ceiling on requests per IP.
  app.use(limiters.global);

  // 6. A friendly reply at the bare address, so opening it in a browser isn't an error.
  app.get('/', (_req, res) => {
    ok(res, { name: 'Lepara Ale fele Moya API', version: 'v1', health: '/api/v1/health' });
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // 7. The API itself.
  app.use('/api/v1', apiRouter);

  // 8. Unknown paths, then the one error handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
