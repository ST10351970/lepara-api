import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

/**
 * The security plan's checks that need the whole app: SQL injection, security
 * headers, and the API documentation. Each test is named after what it proves.
 */

const app = createApp();
const tag = randomUUID().slice(0, 8);

// Classic injection strings. None of them may change data or reveal rows.
const INJECTIONS = [
  "' OR 1=1 --",
  "' OR '1'='1",
  "'; DROP TABLE customer; --",
  "1' UNION SELECT password_hash FROM admin_user --",
];

/** Row counts of the tables an injection would most like to reach. */
async function tableCounts(): Promise<Record<string, number>> {
  const [row] = await testQuery<Record<string, number>>(
    `SELECT (SELECT count(*) FROM admin_user)::int         AS admins,
            (SELECT count(*) FROM customer)::int           AS customers,
            (SELECT count(*) FROM customer_order)::int     AS orders,
            (SELECT count(*) FROM donation)::int           AS donations,
            (SELECT count(*) FROM assistance_request)::int AS requests,
            (SELECT count(*) FROM refresh_token)::int      AS sessions`,
  );
  return row!;
}

describe.skipIf(!hasTestDatabase)('SQL injection', () => {
  let adminId = 0;
  let auth = '';
  let before: Record<string, number>;

  beforeAll(async () => {
    const username = `security.${tag}`;
    const [admin] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Security Check', 'super_admin') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = admin!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`;
    await testQuery(
      `INSERT INTO donation (recorded_by, donor_name, is_anonymous, donation_type, amount,
         date_received)
       VALUES ($1, $2, false, 'Monetary', 50.00, CURRENT_DATE)`,
      [adminId, `Security donor ${tag}`],
    );
    before = await tableCounts();
  });

  afterAll(async () => {
    await testQuery('DELETE FROM donation WHERE recorded_by = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('admin sign-in treats injection text as a wrong username or password', async () => {
    for (const text of INJECTIONS.slice(0, 2)) {
      const res = await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ username: text, password: text });
      expect([400, 401]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    }
  });

  it('customer sign-in treats injection text as a wrong email or password', async () => {
    const badEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: "x' OR '1'='1", password: 'Anything-123' });
    expect(badEmail.status).toBe(400);

    const badPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `nobody.${tag}@example.com`, password: "' OR '1'='1" });
    expect(badPassword.status).toBe(401);
    expect(badPassword.body.error.message).toBe('Your email or password is incorrect.');
  });

  it('tracking refuses injection text in the reference and the phone digits', async () => {
    const reference = await request(app)
      .post('/api/v1/track')
      .send({ referenceNumber: "REQ-ABC123' OR '1'='1", phoneLast4: '5678' });
    expect(reference.status).toBe(400);

    const phone = await request(app)
      .post('/api/v1/track')
      .send({ referenceNumber: 'REQ-ABC123', phoneLast4: "1' OR '1'='1" });
    expect(phone.status).toBe(400);
  });

  it('admin search boxes find nothing for injection text, instead of everything', async () => {
    const lists = [
      '/admin/orders',
      '/admin/volunteer-applications',
      '/admin/assistance-requests',
      '/admin/donations',
      '/admin/users',
      '/admin/stock-items',
    ];
    for (const list of lists) {
      for (const text of INJECTIONS) {
        const res = await request(app)
          .get(`/api/v1${list}`)
          .query({ search: `${text} ${tag}` })
          .set('Authorization', auth);
        expect(res.status, `${list} ${text}`).toBe(200);
        expect(res.body.data, `${list} ${text}`).toEqual([]);
      }
    }
  });

  it('a % in a search is an ordinary character, not "match anything"', async () => {
    const all = await request(app).get('/api/v1/admin/donations').set('Authorization', auth);
    const percent = await request(app)
      .get('/api/v1/admin/donations')
      .query({ search: '%' })
      .set('Authorization', auth);
    expect(all.body.meta.total).toBeGreaterThan(0);
    expect(percent.status).toBe(200);
    expect(percent.body.meta.total).toBeLessThan(all.body.meta.total);
  });

  it('a sort order outside the allowed list falls back to the default', async () => {
    const res = await request(app)
      .get('/api/v1/admin/donations')
      .query({ sort: 'amount; DROP TABLE donation; --' })
      .set('Authorization', auth);
    expect(res.status).toBe(200);
  });

  it('changed no data in any of the tests above', async () => {
    expect(await tableCounts()).toEqual(before);
  });
});

describe('security headers', () => {
  it('sends HSTS, a content security policy and the other helmet headers', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('API documentation', () => {
  it('serves Swagger UI at /api/docs', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('serves the OpenAPI file as YAML and JSON', async () => {
    const yaml = await request(app).get('/api/openapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('openapi: 3.1.0');

    const json = await request(app).get('/api/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.1.0');
  });

  it('documents every route in the code, each with an example reply', async () => {
    const documented = (await request(app).get('/api/openapi.json')).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const missing = routesInCode().filter(
      ({ method, path: route }) => !documented.paths[route]?.[method],
    );
    expect(missing).toEqual([]);

    for (const [route, operations] of Object.entries(documented.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const success = operation.responses['200'] ?? operation.responses['201'];
        expect(success, `${method} ${route}`).toMatchObject({
          content: { 'application/json': { example: { success: true } } },
        });
      }
    }
  });
});

/**
 * Every route the code defines, read from src/routes.ts (where each router is
 * mounted) and the modules' *.routes.ts files (the routes in each router).
 * A new route without documentation makes the test above fail.
 */
function routesInCode(): Array<{ method: string; path: string }> {
  const src = path.join(__dirname, '..', '..', 'src');
  const routesFile = readFileSync(path.join(src, 'routes.ts'), 'utf8');
  const mounts: Array<{ prefix: string; router: string }> = [];
  for (const [, owner, prefix, rest] of routesFile.matchAll(
    /(apiRouter|adminRouter)\.use\(\s*'([^']+)',([^;]+)\);/g,
  )) {
    for (const [router] of rest!.matchAll(/\b\w+Router\b/g)) {
      if (router === 'adminRouter') continue;
      mounts.push({ prefix: `${owner === 'adminRouter' ? '/admin' : ''}${prefix!}`, router });
    }
  }

  const routesOf = new Map<string, Array<{ method: string; path: string }>>();
  const modules = path.join(src, 'modules');
  for (const file of readdirSync(modules, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.routes.ts')) continue;
    const text = readFileSync(path.join(modules, file), 'utf8');
    for (const [, router, method, route] of text.matchAll(
      /\b(\w+Router)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g,
    )) {
      const list = routesOf.get(router!) ?? [];
      list.push({ method: method!, path: route! });
      routesOf.set(router!, list);
    }
    // The public forms are made by one function, formRouter(), with a single POST /.
    for (const [, router] of text.matchAll(/export const (\w+Router) = formRouter\(/g)) {
      routesOf.set(router!, [{ method: 'post', path: '/' }]);
    }
  }

  const routes = mounts.flatMap(({ prefix, router }) =>
    (routesOf.get(router) ?? []).map(({ method, path: route }) => ({
      method,
      path: `${prefix}${route === '/' ? '' : route}`.replace(/:(\w+)/g, '{$1}'),
    })),
  );
  expect(routes.length).toBeGreaterThan(100); // the reader found the routes
  return routes;
}
