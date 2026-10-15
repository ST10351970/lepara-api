import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createLimiter } from '../../src/middleware/rateLimiters';
import { validate, validated } from '../../src/middleware/validate';
import {
  consentGiven,
  emailAddress,
  idParam,
  pagination,
  saPhoneNumber,
} from '../../src/schemas/common';
import { errors } from '../../src/utils/AppError';
import { ok } from '../../src/utils/respond';

/** A tiny app that uses the shared pieces the way real modules will. */
function testApp() {
  const app = express();
  app.use(express.json());

  app.post(
    '/forms/:id',
    validate({
      params: idParam,
      query: pagination,
      body: z.object({ email: emailAddress, phone: saPhoneNumber, consent: consentGiven }),
    }),
    (_req, res) => ok(res, validated(res)),
  );

  app.get('/async-failure', async () => {
    throw errors.conflict('An account with this email already exists.');
  });

  app.get('/bug', () => {
    throw new TypeError("Cannot read properties of undefined (reading 'name')");
  });

  const limiter = createLimiter({ windowMinutes: 1, limit: 2, message: 'Slow down, please.' });
  app.get('/limited', limiter, (_req, res) => ok(res, { fine: true }));

  app.use(errorHandler);
  return app;
}

const app = testApp();

describe('validate middleware', () => {
  it('passes cleaned values to the controller and strips unknown fields', async () => {
    const res = await request(app)
      .post('/forms/7?page=2')
      .send({ email: ' Naledi@Example.com ', phone: '071 234 5678', consent: true, isAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      params: { id: 7 },
      query: { page: 2, pageSize: 20 },
      body: { email: 'naledi@example.com', phone: '+27712345678', consent: true },
    });
  });

  it('reports every bad field at once, one message each', async () => {
    const res = await request(app).post('/forms/abc').send({ email: 'nope', phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = Object.fromEntries(
      res.body.error.fields.map((f: { field: string; message: string }) => [f.field, f.message]),
    );
    expect(fields).toMatchObject({
      id: "We couldn't find that item.",
      email: 'Please enter a valid email, for example name@example.com.',
      phone: 'Please enter a South African number, for example 071 234 5678.',
      consent: 'Please tick the box to agree before sending.',
    });
  });

  it('handles a request with no body at all', async () => {
    const res = await request(app).post('/forms/1');
    expect(res.status).toBe(400);
    expect(res.body.error.fields.length).toBe(3);
  });
});

describe('error handler', () => {
  it('sends errors thrown in async handlers to the error envelope', async () => {
    const res = await request(app).get('/async-failure');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'CONFLICT', message: 'An account with this email already exists.' },
    });
  });

  it('never shows a bug or stack trace to the user', async () => {
    const res = await request(app).get('/bug');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('Cannot read properties');
  });
});

describe('rate limiter', () => {
  it('returns 429 in the standard envelope after the limit', async () => {
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(200);
    const res = await request(app).get('/limited');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Slow down, please.' },
    });
  });
});
