import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, parseServiceAccount } from '../../src/config/env';
import { registerDeviceSchema } from '../../src/modules/devices/devices.schemas';
import { preview } from '../../src/services/notifications';
import {
  type MessagingLike,
  type PushSender,
  deliverPush,
  fcmSender,
  getPushSender,
} from '../../src/services/push';

// A made-up key file: the API only checks its shape before handing it to Firebase.
const keyFile = {
  type: 'service_account',
  project_id: 'lepara-test',
  client_email: 'push@example.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
};

describe('the Firebase service account setting', () => {
  it('accepts the key file as it is, or in base64', () => {
    const expected = {
      projectId: 'lepara-test',
      clientEmail: 'push@example.com',
      privateKey: keyFile.private_key,
    };
    const json = JSON.stringify(keyFile);
    expect(parseServiceAccount(json)).toEqual(expected);
    expect(parseServiceAccount(Buffer.from(json).toString('base64'))).toEqual(expected);
    // Line breaks written out as \n (a common copy-and-paste result) still work.
    const flattened = json.replace(/\\n/g, '\\\\n');
    expect(parseServiceAccount(flattened)?.privateKey).toBe(keyFile.private_key);
  });

  it('refuses anything else, without showing the value', () => {
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: 'x' }))).toBeNull();
    const minimal = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/lepara_dev',
      JWT_ADMIN_SECRET: 'a'.repeat(32),
      JWT_CUSTOMER_SECRET: 'c'.repeat(32),
      TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
    };
    expect(loadEnv(minimal).FIREBASE_SERVICE_ACCOUNT).toBeUndefined();
    expect(loadEnv({ ...minimal, FIREBASE_SERVICE_ACCOUNT: JSON.stringify(keyFile) }))
      .toMatchObject({ FIREBASE_SERVICE_ACCOUNT: { projectId: 'lepara-test' } });
    try {
      loadEnv({ ...minimal, FIREBASE_SERVICE_ACCOUNT: 'secret-looking-value' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as Error).message).toMatch(/FIREBASE_SERVICE_ACCOUNT must be the contents/);
      expect((error as Error).message).not.toContain('secret-looking-value');
    }
  });
});

describe('sending through Firebase', () => {
  it('sends the title, body and data, and spots uninstalled apps', async () => {
    const sent: unknown[] = [];
    const messaging: MessagingLike = {
      sendEachForMulticast: async (message) => {
        sent.push(message);
        return {
          responses: [
            { success: true },
            {
              success: false,
              error: { code: 'messaging/registration-token-not-registered', message: 'gone' },
            },
            { success: false, error: { code: 'messaging/internal-error', message: 'try later' } },
          ],
        };
      },
    };
    const results = await fcmSender(messaging)(['a', 'b', 'c'], {
      title: 'News: Winter drive',
      body: 'Saturday at the hall',
      data: { type: 'announcement', announcementId: '4' },
    });
    expect(sent[0]).toMatchObject({
      tokens: ['a', 'b', 'c'],
      notification: { title: 'News: Winter drive', body: 'Saturday at the hall' },
      data: { type: 'announcement', announcementId: '4' },
    });
    expect(results.map((result) => [result.token, result.ok, result.invalidToken])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', false, false],
    ]);
  });

  it('sends 500 at a time, and a failed batch never stops the rest', async () => {
    const batches: number[] = [];
    let calls = 0;
    const sender: PushSender = async (tokens) => {
      calls += 1;
      if (calls === 2) throw new Error('Firebase is unreachable');
      batches.push(tokens.length);
      return tokens.map((token) => ({
        token,
        ok: !token.endsWith('dead'),
        invalidToken: token.endsWith('dead'),
      }));
    };
    const tokens = Array.from({ length: 1203 }, (_, index) =>
      index % 400 === 7 ? `phone-${index}-dead` : `phone-${index}`,
    );
    const outcome = await deliverPush(tokens, { title: 't', body: 'b' }, sender);
    expect(calls).toBe(3);
    expect(batches).toEqual([500, 203]);
    expect(outcome.failed).toBe(500 + 2); // the failed batch, and 2 uninstalled apps
    expect(outcome.sent).toBe(703 - 2);
    // phone-807-dead was in the failed batch, so it is kept for the next send.
    expect(outcome.invalidTokens).toEqual(['phone-7-dead', 'phone-407-dead']);
  });

  it('is off in tests and when Firebase is not set up', async () => {
    expect(await getPushSender()).toBeNull();
  });
});

describe('notification text and device tokens', () => {
  it('keeps the announcement preview short', () => {
    expect(preview('Short   and\nsweet')).toBe('Short and sweet');
    const long = preview('word '.repeat(100));
    expect(long.length <= 150).toBe(true);
    expect(long.endsWith('…')).toBe(true);
  });

  it('wants the native token, not an Expo push token', () => {
    const expo = registerDeviceSchema.safeParse({
      token: 'ExponentPushToken[abcdefghijklmnopqrstuv]',
      platform: 'android',
    });
    expect(expo.error?.issues[0]?.message).toMatch(/getDevicePushTokenAsync/);
    const fcm = registerDeviceSchema.parse({
      token: ' dGVzdA:APA91bExampleTokenValue_with-allowed.chars ',
      platform: 'android',
    });
    expect(fcm.token).toBe('dGVzdA:APA91bExampleTokenValue_with-allowed.chars');
    expect(registerDeviceSchema.safeParse({ token: fcm.token, platform: 'web' }).success).toBe(
      false,
    );
  });
});
