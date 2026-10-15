import { describe, expect, it } from 'vitest';
import {
  eventPhase,
  formatDateLabel,
  formatTimeLabel,
} from '../../src/modules/initiatives/initiatives.format';
import {
  createInitiativeSchema,
  publicListQuery,
  statusChangeSchema,
  updateInitiativeSchema,
} from '../../src/modules/initiatives/initiatives.schemas';
import { detectImageType } from '../../src/utils/imageType';

describe('event labels for the app', () => {
  it('writes dates the way the app shows them', () => {
    expect(formatDateLabel('2026-10-24', '2026-10-24')).toBe('24 Oct 2026');
    expect(formatDateLabel('2026-10-24', '2026-10-25')).toBe('24–25 Oct 2026');
    expect(formatDateLabel('2026-10-30', '2026-11-02')).toBe('30 Oct – 2 Nov 2026');
    expect(formatDateLabel('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });

  it('writes times in South African time, or nothing if there are none', () => {
    expect(formatTimeLabel('10:00', '14:00')).toBe('10:00–14:00 SAST');
    expect(formatTimeLabel('10:00', null)).toBe('From 10:00 SAST');
    expect(formatTimeLabel(null, '14:00')).toBe('Until 14:00 SAST');
    expect(formatTimeLabel(null, null)).toBeNull();
  });

  it('calls an event Upcoming until its last day has passed in Johannesburg', () => {
    const today = '2026-10-24';
    expect(eventPhase('Published', '2026-10-25', today)).toBe('Upcoming');
    expect(eventPhase('Published', '2026-10-24', today)).toBe('Upcoming'); // the day itself
    expect(eventPhase('Published', '2026-10-23', today)).toBe('Completed');
    expect(eventPhase('Closed', '2026-12-01', today)).toBe('Completed');
    expect(eventPhase('Draft', '2026-12-01', today)).toBeNull();
  });
});

describe('photo file types', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const text = (value: string) => Uint8Array.from(Buffer.from(value));

  it('recognises real JPEG, PNG and WebP files by their first bytes', () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))?.mimeType).toBe('image/jpeg');
    expect(
      detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))?.mimeType,
    ).toBe('image/png');
    expect(detectImageType(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))?.mimeType).toBe(
      'image/webp',
    );
  });

  it('refuses anything else, whatever its name says', () => {
    expect(detectImageType(text('This is a text file renamed to photo.jpg'))).toBeNull();
    expect(detectImageType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageType(text('GIF89a'))).toBeNull();
    expect(detectImageType(text('RIFF\u0000\u0000\u0000\u0000WAVE'))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe('event forms', () => {
  const valid = {
    typeId: 1,
    title: 'Community clothing drive',
    description: 'Help sort clothing and prepare donation bundles for neighbours.',
    startDate: '2026-10-24',
    endDate: '2026-10-24',
  };

  it('accepts a minimal draft and fills in the defaults', () => {
    const result = createInitiativeSchema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data?.volunteersRequired).toBe(false);
  });

  it('checks dates and times together', () => {
    const result = createInitiativeSchema.safeParse({
      ...valid,
      endDate: '2026-10-23',
    });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['endDate'],
      message: "The end date can't be before the start date.",
    });

    const times = createInitiativeSchema.safeParse({
      ...valid,
      startTime: '14:00',
      endTime: '10:00',
    });
    expect(times.error?.issues[0]).toMatchObject({
      path: ['endTime'],
      message: 'The end time must be after the start time.',
    });

    const badTime = createInitiativeSchema.safeParse({ ...valid, startTime: '9.30' });
    expect(badTime.error?.issues[0]?.message).toBe(
      'Please enter the time as HH:MM, for example 09:30.',
    );
  });

  it('needs at least one change when editing, and allows clearing optional fields', () => {
    expect(updateInitiativeSchema.safeParse({}).success).toBe(false);
    expect(updateInitiativeSchema.safeParse({ location: null }).success).toBe(true);
  });

  it('only knows the three statuses', () => {
    expect(statusChangeSchema.safeParse({ status: 'Published' }).success).toBe(true);
    expect(statusChangeSchema.safeParse({ status: 'Cancelled' }).error?.issues[0]?.message).toBe(
      'Please choose Draft, Published or Closed.',
    );
  });

  it('ignores list filters it does not understand', () => {
    expect(publicListQuery.parse({ phase: 'later', typeId: 'abc' })).toEqual({
      page: 1,
      pageSize: 20,
      phase: 'all',
      typeId: undefined,
    });
  });
});
