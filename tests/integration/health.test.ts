import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { hasTestDatabase } from '../setup/testDatabase';

describe.skipIf(!hasTestDatabase)('GET /api/v1/health with the test database', () => {
  afterAll(async () => {
    await closePool();
  });

  it('reports the API and database as up', async () => {
    const res = await request(createApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok', database: 'up' } });
  });
});
