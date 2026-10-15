import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/utils/logger';

describe('log redaction', () => {
  it('hides passwords, codes and tokens in anything logged', () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '[hidden]' } },
      { write: (line: string) => void lines.push(line) },
    );

    log.info(
      {
        body: {
          username: 'founder',
          password: 'Sunrise-Drive-2026',
          code: '492039',
          pendingToken: 'eyJhbGciOiJIUzI1NiJ9.sign-in',
          backupCodes: ['ABCDE-FGHJK'],
        },
        session: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.access', refreshToken: 'cookie-value' },
        req: { headers: { authorization: 'Bearer eyJ.secret', cookie: 'lepara_admin_refresh=x' } },
      },
      'example',
    );

    const output = lines.join('');
    for (const secret of [
      'Sunrise-Drive-2026',
      '492039',
      'sign-in',
      'ABCDE-FGHJK',
      '.access',
      'cookie-value',
      'Bearer',
      'lepara_admin_refresh',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('founder'); // ordinary details are still there for debugging
    expect(output).toContain('[hidden]');
  });
});
