import { describe, expect, it } from 'vitest';
import { trackSchema } from '../../src/modules/tracking/tracking.schemas';
import { TRACKED_STATUSES, sameLast4 } from '../../src/modules/tracking/tracking.service';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

describe('tracking form', () => {
  it('reads reference numbers the way people type them', () => {
    for (const typed of ['req-7k3p9x', 'REQ 7K3 P9X', 'req7k3p9x', ' REQ-7K3P9X ']) {
      expect(trackSchema.parse({ referenceNumber: typed, phoneLast4: '5678' })).toEqual({
        referenceNumber: 'REQ-7K3P9X',
        phoneLast4: '5678',
      });
    }
  });

  it('explains what to enter', () => {
    const result = trackSchema.safeParse({ referenceNumber: 'hello', phoneLast4: '12a4' });
    expect(firstMessages(result)).toEqual({
      referenceNumber: 'Please enter your reference number, for example REQ-7K3P9X.',
      phoneLast4: 'Please enter the last 4 digits of your phone number.',
    });
    // O and 1 are never used in reference numbers.
    const confusing = trackSchema.safeParse({ referenceNumber: 'VOL-O1O1O1', phoneLast4: '1234' });
    expect(confusing.success).toBe(false);
  });
});

describe('matching the phone digits', () => {
  it('needs all 4 digits to match', () => {
    expect(sameLast4('5678', '5678')).toBe(true);
    expect(sameLast4('5679', '5678')).toBe(false);
    expect(sameLast4('5678', '----')).toBe(false);
  });

  it('covers every status the database allows', () => {
    expect(TRACKED_STATUSES).toEqual({
      VOL: ['Submitted', 'Accepted', 'Declined', 'Attended', 'Did not attend'],
      REQ: ['Submitted', 'Under review', 'Approved', 'Declined', 'Fulfilled', 'Closed'],
      PLG: ['Pending', 'Accepted', 'Received', 'Declined'],
    });
  });
});
