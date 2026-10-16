import { describe, expect, it } from 'vitest';
import {
  enquiryStatusSchema,
  pledgeDecisionSchema,
  requestDecisionSchema,
  requestListQuery,
  volunteerDecisionSchema,
  volunteerListQuery,
} from '../../src/modules/reviews/reviews.schemas';
import {
  canMove,
  isFinalStatus,
  refusalMessage,
} from '../../src/modules/reviews/reviews.transitions';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

describe('the Task 1 state machines', () => {
  it('moves a volunteer application forward only', () => {
    expect(canMove('volunteer', 'Submitted', 'Accepted')).toBe(true);
    expect(canMove('volunteer', 'Submitted', 'Declined')).toBe(true);
    expect(canMove('volunteer', 'Accepted', 'Attended')).toBe(true);
    expect(canMove('volunteer', 'Accepted', 'Did not attend')).toBe(true);
    expect(canMove('volunteer', 'Submitted', 'Attended')).toBe(false);
    expect(canMove('volunteer', 'Accepted', 'Declined')).toBe(false);
    expect(canMove('volunteer', 'Declined', 'Accepted')).toBe(false);
  });

  it('moves an assistance request forward only, through fulfilment', () => {
    expect(canMove('request', 'Submitted', 'Under review')).toBe(true);
    expect(canMove('request', 'Under review', 'Approved')).toBe(true);
    expect(canMove('request', 'Under review', 'Declined')).toBe(true);
    expect(canMove('request', 'Approved', 'Fulfilled')).toBe(true);
    expect(canMove('request', 'Fulfilled', 'Closed')).toBe(true);
    expect(canMove('request', 'Approved', 'Closed')).toBe(false);
    expect(canMove('request', 'Declined', 'Closed')).toBe(false);
    expect(canMove('request', 'Under review', 'Submitted')).toBe(false);
  });

  it('moves a pledge from Pending to a decision, then to Received', () => {
    expect(canMove('pledge', 'Pending', 'Accepted')).toBe(true);
    expect(canMove('pledge', 'Accepted', 'Received')).toBe(true);
    expect(canMove('pledge', 'Accepted', 'Declined')).toBe(false);
  });

  it('knows which decisions are final, and explains a refusal', () => {
    for (const status of ['Declined', 'Attended', 'Did not attend']) {
      expect(isFinalStatus('volunteer', status)).toBe(true);
    }
    expect(isFinalStatus('request', 'Closed')).toBe(true);
    expect(isFinalStatus('request', 'Approved')).toBe(false);
    expect(refusalMessage('volunteer', 'Declined', 'Accepted')).toBe(
      "This application is already Declined, which is final, so it can't be changed.",
    );
    expect(refusalMessage('request', 'Approved', 'Closed')).toMatch(/Only a fulfilled request/);
    expect(refusalMessage('pledge', 'Accepted', 'Accepted')).toBe(
      'This pledge is already Accepted.',
    );
  });
});

describe('decision forms', () => {
  it('needs a reason to decline, on every queue', () => {
    for (const schema of [volunteerDecisionSchema, requestDecisionSchema, pledgeDecisionSchema]) {
      expect(firstMessages(schema.safeParse({ status: 'Declined' }))).toEqual({
        reason:
          'Please give a reason for declining (at least 3 characters). The person will see it in their email.',
      });
      expect(schema.parse({ status: 'Declined', reason: '  Fully booked.  ' }).reason).toBe(
        'Fully booked.',
      );
    }
  });

  it('only offers the moves each endpoint makes', () => {
    expect(firstMessages(volunteerDecisionSchema.safeParse({ status: 'Submitted' })).status).toBe(
      'Please choose Accepted, Declined, Attended or Did not attend.',
    );
    expect(requestDecisionSchema.safeParse({ status: 'Fulfilled' }).success).toBe(false);
    expect(pledgeDecisionSchema.safeParse({ status: 'Received' }).success).toBe(false);
    expect(enquiryStatusSchema.parse({ status: 'Reviewed' })).toEqual({ status: 'Reviewed' });
  });

  it('keeps reasons to 500 characters', () => {
    const long = requestDecisionSchema.safeParse({ status: 'Declined', reason: 'x'.repeat(501) });
    expect(firstMessages(long).reason).toBe('Please keep the reason under 500 characters.');
  });
});

describe('queue filters', () => {
  it('reads filters and ignores ones it does not understand', () => {
    expect(
      volunteerListQuery.parse({
        status: 'Accepted',
        initiativeId: '12',
        taskId: 'abc',
        from: '2026-10-01',
        to: '2026-02-30',
        search: '  sipho ',
        sort: 'name',
      }),
    ).toEqual({
      page: 1,
      pageSize: 20,
      status: 'Accepted',
      initiativeId: 12,
      taskId: undefined,
      from: '2026-10-01',
      to: undefined,
      search: 'sipho',
      sort: 'name',
    });
    expect(requestListQuery.parse({ status: 'Lost', requestType: 'Cars' })).toMatchObject({
      status: 'all',
      requestType: undefined,
    });
  });
});
