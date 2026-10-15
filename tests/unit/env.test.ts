import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../../src/config/env';

const minimal = { DATABASE_URL: 'postgres://user:pass@localhost:5432/lepara_dev' };

describe('loadEnv', () => {
  it('fills in safe defaults', () => {
    const env = loadEnv(minimal);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_SSL).toBe(false);
    expect(env.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe(true);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.TRUST_PROXY).toBe(0);
  });

  it('reads lists, numbers and flags', () => {
    const env = loadEnv({
      ...minimal,
      PORT: '8080',
      DATABASE_SSL: 'true',
      CORS_ORIGINS: 'https://lepara.example, http://localhost:5173 ,',
      TRUST_PROXY: '1',
    });
    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_SSL).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['https://lepara.example', 'http://localhost:5173']);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it('stops with a clear message when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    try {
      loadEnv({});
    } catch (error) {
      expect((error as EnvError).problems.join(' ')).toContain('DATABASE_URL');
    }
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
    expect(() => loadEnv({ ...minimal, PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...minimal, DATABASE_SSL: 'yes' })).toThrow(/DATABASE_SSL/);
  });

  it('insists on SSL to the database in production', () => {
    expect(() => loadEnv({ ...minimal, NODE_ENV: 'production' })).toThrow(
      /must be true in production/,
    );
    expect(loadEnv({ ...minimal, NODE_ENV: 'production', DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(
      true,
    );
  });
});
