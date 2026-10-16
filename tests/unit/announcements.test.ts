import { describe, expect, it } from 'vitest';
import {
  activeSchema,
  adminListQuery,
  createAnnouncementSchema,
  updateAnnouncementSchema,
} from '../../src/modules/announcements/announcements.schemas';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) =>
  Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.') || 'request', issue.message]),
  );

describe('announcement forms', () => {
  it('accepts a title of 5 to 120 characters and a body of 10 to 2,000', () => {
    const ok = createAnnouncementSchema.safeParse({
      title: '  Winter drive dates  ',
      body: 'Our winter collection runs from 14 November.',
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.title).toBe('Winter drive dates');

    expect(
      firstMessages(createAnnouncementSchema.safeParse({ title: 'Hi', body: 'Too short' })),
    ).toEqual({
      title: 'Please enter a title of at least 5 characters.',
      body: 'Please write at least 10 characters.',
    });
    expect(
      firstMessages(
        createAnnouncementSchema.safeParse({ title: 'x'.repeat(121), body: 'y'.repeat(2001) }),
      ),
    ).toEqual({
      title: 'Please keep the title under 120 characters.',
      body: 'Please keep the announcement under 2,000 characters.',
    });
  });

  it('needs at least one change when editing', () => {
    expect(firstMessages(updateAnnouncementSchema.safeParse({}))).toEqual({
      request: 'Please change at least one detail.',
    });
  });

  it('needs a clear yes or no to show or hide', () => {
    expect(activeSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(activeSchema.safeParse({ isActive: 'no' }).success).toBe(false);
  });

  it('ignores list filters it does not understand', () => {
    expect(adminListQuery.parse({ status: 'archived' })).toEqual({
      page: 1,
      pageSize: 20,
      status: 'all',
      search: undefined,
    });
  });
});
