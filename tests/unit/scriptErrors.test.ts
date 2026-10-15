import { describe, expect, it } from 'vitest';
import { explainScriptError } from '../../db/connection';

const refused = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });

describe('explainScriptError', () => {
  it('never prints an empty message for a Windows localhost failure', () => {
    // Windows tries ::1 and 127.0.0.1; Node reports both as an AggregateError with no message.
    const aggregate = Object.assign(
      new AggregateError([refused('::1:5432'), refused('127.0.0.1:5432')], ''),
      { code: 'ECONNREFUSED' },
    );
    const text = explainScriptError(aggregate, 'postgres://u:p@localhost:5432/lepara_dev');
    expect(text).toContain('Could not reach localhost:5432/lepara_dev');
    expect(text).toContain('MIGRATION_DATABASE_URL');
    expect(text).toContain('ECONNREFUSED 127.0.0.1:5432');
  });

  it('points at the host for a cloud database it cannot reach', () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND ep-x.neon.tech'), {
      code: 'ENOTFOUND',
    });
    const text = explainScriptError(notFound, 'postgres://u:p@ep-x.neon.tech/lepara_dev');
    expect(text).toContain('Could not reach ep-x.neon.tech/lepara_dev');
    expect(text).toContain('Check the host name');
  });

  it('explains a wrong password and a missing database', () => {
    const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    expect(explainScriptError(auth)).toContain('username or password');
    const missing = Object.assign(new Error('database "x" does not exist'), { code: '3D000' });
    expect(explainScriptError(missing)).toContain('does not exist on that server');
  });

  it('never leaks the password from the connection string', () => {
    const text = explainScriptError(refused('1.2.3.4:5432'), 'postgres://u:S3cretPw@host/db');
    expect(text).not.toContain('S3cretPw');
  });

  it('falls back to the plain message for anything else', () => {
    expect(explainScriptError(new Error('Something odd'))).toBe('Error: Something odd');
    expect(explainScriptError('text')).toBe('Error: text');
  });
});
