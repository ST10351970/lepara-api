import { describe, expect, it } from 'vitest';
import {
  createAdminSchema,
  listAdminsQuery,
  updateAdminSchema,
} from '../../src/modules/adminUsers/adminUsers.schemas';
import { generateTemporaryPassword } from '../../src/modules/adminUsers/temporaryPassword';
import { password } from '../../src/schemas/common';
import { likeContains } from '../../src/utils/sql';

/** The first message for each field, as the website would show it. */
function messages(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.') || 'request', issue.message]),
  );
}

describe('temporary passwords', () => {
  it('are easy to read, always pass the password rules, and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const temporary = generateTemporaryPassword();
      // No look-alikes: 0, 1, i, l, o, I, L or O.
      expect(temporary).toMatch(/^([a-hjkmnp-zA-HJKMNP-Z2-9]{4}-){2}[a-hjkmnp-zA-HJKMNP-Z2-9]{4}$/);
      expect(password.safeParse(temporary).success).toBe(true);
      seen.add(temporary);
    }
    expect(seen.size).toBe(200);
  });
});

describe('likeContains', () => {
  it('matches text anywhere and treats % and _ as ordinary characters', () => {
    expect(likeContains('naledi')).toBe('%naledi%');
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('admin management forms', () => {
  it('cleans up a new admin and makes them staff unless chosen otherwise', () => {
    const result = createAdminSchema.safeParse({
      username: '  Thabo.M ',
      fullName: 'Thabo Mokoena',
      email: 'Thabo@Example.com',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      username: 'thabo.m',
      fullName: 'Thabo Mokoena',
      email: 'thabo@example.com',
      role: 'staff',
    });
  });

  it('explains what is wrong with a new admin', () => {
    const result = createAdminSchema.safeParse({ username: 'a b', email: 'nope', role: 'boss' });
    expect(messages(result)).toEqual({
      username: 'Usernames are 3 to 50 characters: letters, numbers, dots, dashes or underscores.',
      fullName: 'Please enter the full name.',
      email: 'Please enter a valid email, for example name@example.com.',
      role: 'Please choose a role: super admin or staff.',
    });
  });

  it('needs at least one change when editing', () => {
    expect(messages(updateAdminSchema.safeParse({}))).toEqual({
      request: 'Please change at least one detail.',
    });
    expect(messages(updateAdminSchema.safeParse({ isActive: 'no' }))).toEqual({
      isActive: 'Please choose active or inactive.',
    });
    expect(updateAdminSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('falls back to sensible list filters', () => {
    expect(listAdminsQuery.parse({ status: 'weird', search: '  ' })).toEqual({
      page: 1,
      pageSize: 20,
      status: 'all',
      search: undefined,
    });
    expect(listAdminsQuery.parse({ status: 'inactive', search: 'thabo' }).status).toBe('inactive');
  });
});
