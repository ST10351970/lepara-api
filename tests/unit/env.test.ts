import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../../src/config/env';

const minimal = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/lepara_dev',
  JWT_ADMIN_SECRET: 'a'.repeat(32),
  JWT_CUSTOMER_SECRET: 'c'.repeat(32),
  TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
};

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

  it('needs the admin sign-in secrets, and checks their shape', () => {
    try {
      loadEnv({ DATABASE_URL: minimal.DATABASE_URL });
      throw new Error('Expected loadEnv to fail');
    } catch (error) {
      const problems = (error as EnvError).problems.join(' ');
      expect(problems).toContain('JWT_ADMIN_SECRET');
      expect(problems).toContain('TOTP_ENCRYPTION_KEY');
    }
    expect(() => loadEnv({ ...minimal, JWT_ADMIN_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...minimal, JWT_CUSTOMER_SECRET: undefined })).toThrow(
      /JWT_CUSTOMER_SECRET/,
    );
    expect(() => loadEnv({ ...minimal, JWT_CUSTOMER_SECRET: 'a'.repeat(32) })).toThrow(
      /different from JWT_ADMIN_SECRET/,
    );
    expect(() => loadEnv({ ...minimal, TOTP_ENCRYPTION_KEY: 'xyz'.repeat(20) })).toThrow(/64 hex/);
  });

  it('treats photo storage as optional and checks its settings', () => {
    const plain = loadEnv(minimal);
    expect(plain.AZURE_STORAGE_CONNECTION_STRING).toBeUndefined();
    expect(plain.AZURE_STORAGE_CONTAINER).toBe('images');
    expect(
      loadEnv({ ...minimal, AZURE_STORAGE_CONNECTION_STRING: '  ' })
        .AZURE_STORAGE_CONNECTION_STRING,
    ).toBeUndefined();
    expect(() =>
      loadEnv({ ...minimal, AZURE_STORAGE_CONNECTION_STRING: 'not-a-connection-string' }),
    ).toThrow(/AZURE_STORAGE_CONNECTION_STRING/);
    expect(() => loadEnv({ ...minimal, AZURE_STORAGE_CONTAINER: 'Images!' })).toThrow(
      /AZURE_STORAGE_CONTAINER/,
    );
  });

  it('treats email as optional and checks its settings', () => {
    const plain = loadEnv({ ...minimal, SMTP_HOST: '', SMTP_PORT: '', MAIL_FROM: ' ' });
    expect(plain.SMTP_HOST).toBeUndefined();
    expect(plain.BREVO_API_KEY).toBeUndefined();
    expect(plain.SMTP_PORT).toBe(587);
    expect(plain.SMTP_SECURE).toBeUndefined();

    const gmail = loadEnv({
      ...minimal,
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'lepara@gmail.com',
      SMTP_PASS: 'app-password',
      MAIL_FROM: 'Lepara Ale fele Moya <lepara@gmail.com>',
    });
    expect(gmail.SMTP_PORT).toBe(465);
    expect(gmail.MAIL_FROM).toBe('Lepara Ale fele Moya <lepara@gmail.com>');

    expect(() => loadEnv({ ...minimal, SMTP_HOST: 'smtp.gmail.com' })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...minimal, BREVO_API_KEY: 'xkeysib-test' })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...minimal, SMTP_USER: 'someone' })).toThrow(/SMTP_PASS/);
    expect(() => loadEnv({ ...minimal, MAIL_FROM: 'not an address' })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...minimal, SMTP_SECURE: 'yes' })).toThrow(/SMTP_SECURE/);
  });

  it('charges R60 delivery unless set, and takes the EFT bank details all together', () => {
    expect(loadEnv(minimal).DELIVERY_FEE_CENTS).toBe(6000);
    expect(loadEnv({ ...minimal, DELIVERY_FEE_CENTS: '' }).DELIVERY_FEE_CENTS).toBe(6000);
    expect(loadEnv({ ...minimal, DELIVERY_FEE_CENTS: '7500' }).DELIVERY_FEE_CENTS).toBe(7500);
    expect(loadEnv({ ...minimal, DELIVERY_FEE_CENTS: '0' }).DELIVERY_FEE_CENTS).toBe(0);
    // Rands by mistake: "60" would be 60 cents, and "60.00" isn't cents at all.
    expect(() => loadEnv({ ...minimal, DELIVERY_FEE_CENTS: '60' })).toThrow(/6000 is R60/);
    expect(() => loadEnv({ ...minimal, DELIVERY_FEE_CENTS: '60.00' })).toThrow(
      /DELIVERY_FEE_CENTS/,
    );

    const bank = {
      EFT_BANK_NAME: 'Example Bank',
      EFT_ACCOUNT_NAME: 'Lepara Ale fele Moya NPC',
      EFT_ACCOUNT_NUMBER: '1234567890',
      EFT_BRANCH_CODE: '250655',
    };
    expect(loadEnv({ ...minimal, ...bank }).EFT_ACCOUNT_NUMBER).toBe('1234567890');
    expect(loadEnv(minimal).EFT_BANK_NAME).toBeUndefined();
    expect(() => loadEnv({ ...minimal, ...bank, EFT_BRANCH_CODE: '' })).toThrow(
      /EFT_BRANCH_CODE is required/,
    );
    expect(() => loadEnv({ ...minimal, ...bank, EFT_BRANCH_CODE: '25065' })).toThrow(
      /6-digit branch code/,
    );
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
