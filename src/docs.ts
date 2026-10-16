import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Request, type Response, Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { errors } from './utils/AppError';
import { logger } from './utils/logger';

/**
 * The API documentation, for the website and mobile teams and the lecturer:
 *
 *   /api/docs              Swagger UI: every endpoint with an example request and reply,
 *                          and "Try it out" against this server
 *   /api/openapi.yaml      the OpenAPI file itself (import it into Postman or Insomnia)
 *   /api/openapi.json      the same as JSON
 *
 * The file is docs/openapi.yaml in the repository. It is read once at start-up;
 * if it is missing, these pages answer 503 and the API itself works as normal.
 */

const DOCS_FILE = path.join(__dirname, '..', 'docs', 'openapi.yaml');

function loadDocument(): { text: string; document: Record<string, unknown> } | null {
  try {
    const text = readFileSync(DOCS_FILE, 'utf8');
    return { text, document: parse(text) as Record<string, unknown> };
  } catch (error) {
    logger.warn({ err: error, file: DOCS_FILE }, 'The API documentation could not be loaded');
    return null;
  }
}

export function docsRouter() {
  const router = Router();
  const loaded = loadDocument();

  if (!loaded) {
    for (const page of ['/docs', '/openapi.yaml', '/openapi.json']) {
      router.use(page, () => {
        throw errors.unavailable('The API documentation is not available on this server.');
      });
    }
    return router;
  }

  router.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.type('application/yaml').send(loaded.text);
  });
  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(loaded.document);
  });
  router.use(
    '/docs',
    ...swaggerUi.serve,
    swaggerUi.setup(loaded.document, {
      customSiteTitle: 'Lepara Ale fele Moya API',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', tryItOutEnabled: false },
    }),
  );
  return router;
}
