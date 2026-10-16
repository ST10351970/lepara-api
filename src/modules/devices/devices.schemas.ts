import { z } from 'zod';

/**
 * A phone's push notification token: the native token from expo-notifications'
 * getDevicePushTokenAsync() (an FCM token on Android). Expo's own push tokens
 * ("ExponentPushToken[...]") only work with Expo's push service, not Firebase.
 */

const TOKEN_MESSAGE = 'This device token is not valid.';

export const deviceToken = z
  .string({ error: TOKEN_MESSAGE })
  .trim()
  .refine(
    (value) => !value.startsWith('ExponentPushToken'),
    'Please send the native device token from getDevicePushTokenAsync(), not an Expo push token.',
  )
  .refine((value) => /^[A-Za-z0-9:_.-]{20,512}$/.test(value), TOKEN_MESSAGE);

/** POST /devices */
export const registerDeviceSchema = z.object({
  token: deviceToken,
  platform: z.enum(['android', 'ios'], { error: 'Please choose android or ios.' }),
});

/** DELETE /devices/:token */
export const deviceTokenParams = z.object({ token: deviceToken });

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type DeviceTokenParams = z.infer<typeof deviceTokenParams>;
