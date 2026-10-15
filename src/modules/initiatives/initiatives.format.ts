/**
 * Ready-made labels for the app's event cards, so every screen shows dates
 * and times the same way:
 *   dateLabel  "24 Oct 2026", "24–25 Oct 2026", "30 Oct – 2 Nov 2026"
 *   timeLabel  "10:00–14:00 SAST", "From 10:00 SAST", or null
 *   phase      "Upcoming" or "Completed" (null for drafts, which are never public)
 * Dates arrive as YYYY-MM-DD text and are never turned into Date objects, so
 * the server's own time zone can't shift them by a day.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(isoDate: string): { day: number; month: string; year: string } {
  const [year, month, day] = isoDate.split('-');
  return { day: Number(day), month: MONTHS[Number(month) - 1] ?? '', year: year ?? '' };
}

export function formatDateLabel(startDate: string, endDate: string): string {
  const start = parts(startDate);
  const end = parts(endDate);
  if (startDate === endDate) return `${start.day} ${start.month} ${start.year}`;
  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${end.day} ${end.month} ${end.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${start.month} – ${end.day} ${end.month} ${end.year}`;
  }
  return `${start.day} ${start.month} ${start.year} – ${end.day} ${end.month} ${end.year}`;
}

export function formatTimeLabel(startTime: string | null, endTime: string | null): string | null {
  if (startTime && endTime) return `${startTime}–${endTime} SAST`;
  if (startTime) return `From ${startTime} SAST`;
  if (endTime) return `Until ${endTime} SAST`;
  return null;
}

export type InitiativeStatus = 'Draft' | 'Published' | 'Closed';
export type EventPhase = 'Upcoming' | 'Completed';

/**
 * A published event is Upcoming until its last day has passed in
 * Johannesburg (so it is still Upcoming on the day itself). A closed event,
 * or a published one whose end date has passed, is Completed.
 */
export function eventPhase(
  status: InitiativeStatus,
  endDate: string,
  today: string,
): EventPhase | null {
  if (status === 'Draft') return null;
  return status === 'Published' && endDate >= today ? 'Upcoming' : 'Completed';
}
