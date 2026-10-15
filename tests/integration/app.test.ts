import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';

// This file pretends the database is down, so it needs no database at all.
// (Vitest moves vi.mock above the imports, so the app gets the fake.)
vi.mock('../../src/modules/health/health.repository', () => ({
  pingDatabase: () => Promise.reject(new Error('Connection terminated unexpectedly')),
}));

const app = createApp();

describe('the app shell', () => {
  it('answers the bare address with the API name instead of an error', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { name: 'Lepara Ale fele Moya API', health: '/api/v1/health' },
    });
    expect((await request(app).get('/favicon.ico')).status).toBe(204);
  });

  it('answers an unknown path with a 404 envelope and a request ID', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(res.body.error.message).toMatch(/doesn't exist/);
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('keeps a valid request ID sent by the client, so logs can be matched', async () => {
    const res = await request(app).get('/nope').set('X-Request-Id', 'mobile-app-12345678');
    expect(res.headers['x-request-id']).toBe('mobile-app-12345678');
  });

  it('answers malformed JSON with a 400, not a crash', async () => {
    const res = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"name": "Naledi"');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'INVALID_JSON' } });
  });

  it('refuses bodies over 100 KB', async () => {
    const res = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(110 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sends security headers and hides the framework', async () => {
    const res = await request(app).get('/nope');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the website to call the API from a browser', async () => {
    const res = await request(app).get('/nope').set('Origin', 'https://website.test');
    expect(res.headers['access-control-allow-origin']).toBe('https://website.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives other websites no access', async () => {
    const res = await request(app).get('/nope').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reports 503 from /health when the database is unreachable', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(res.body.error.message).toMatch(/can't reach the server/);
  });
});
