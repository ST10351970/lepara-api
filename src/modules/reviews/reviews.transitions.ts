/**
 * The Task 1 state machines (Section 7.6), as data. A status can only move
 * along these arrows; nothing moves backwards.
 *
 *   Volunteer application  Submitted → Accepted → Attended | Did not attend
 *                          Submitted → Declined
 *   Assistance request     Submitted → Under review (an admin opens it)
 *                          Under review → Approved → Fulfilled → Closed
 *                          Under review → Declined
 *   Donation pledge        Pending → Accepted → Received
 *                          Pending → Declined
 *
 * Fulfilled (assistance) and Received (pledge) are recorded with the stock
 * and donation records in step 13, not with the decision endpoints.
 */

export type SubmissionKind = 'volunteer' | 'request' | 'pledge';

const ARROWS: Record<SubmissionKind, Record<string, readonly string[]>> = {
  volunteer: {
    Submitted: ['Accepted', 'Declined'],
    Accepted: ['Attended', 'Did not attend'],
  },
  request: {
    // An admin may decide straight away: deciding counts as opening it.
    Submitted: ['Under review', 'Approved', 'Declined'],
    'Under review': ['Approved', 'Declined'],
    Approved: ['Fulfilled'],
    Fulfilled: ['Closed'],
  },
  pledge: {
    Pending: ['Accepted', 'Declined'],
    Accepted: ['Received'],
  },
};

export const NOUNS: Record<SubmissionKind, string> = {
  volunteer: 'application',
  request: 'request',
  pledge: 'pledge',
};

export function canMove(kind: SubmissionKind, from: string, to: string): boolean {
  return ARROWS[kind][from]?.includes(to) ?? false;
}

/** No arrows lead out of these: the decision is final. */
export function isFinalStatus(kind: SubmissionKind, status: string): boolean {
  return (ARROWS[kind][status] ?? []).length === 0;
}

/** A plain explanation of why a move isn't allowed, for the 409 reply. */
export function refusalMessage(kind: SubmissionKind, from: string, to: string): string {
  const noun = NOUNS[kind];
  if (from === to) return `This ${noun} is already ${from}.`;
  if (isFinalStatus(kind, from)) {
    return `This ${noun} is already ${from}, which is final, so it can't be changed.`;
  }
  if (kind === 'volunteer' && from === 'Submitted') {
    return 'Accept the application before recording attendance.';
  }
  if (kind === 'volunteer' && from === 'Accepted') {
    return 'This application has already been accepted, so it can only be marked Attended or Did not attend.';
  }
  if (kind === 'request' && to === 'Closed') {
    return 'Only a fulfilled request can be closed. Record what was given first.';
  }
  return `This ${noun} is already ${from}, so it can't be changed to ${to}.`;
}
