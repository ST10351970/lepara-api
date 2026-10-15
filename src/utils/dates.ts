/** The organisation works in South African time, so "today" means today in Johannesburg. */
export const TIME_ZONE = 'Africa/Johannesburg';

const isoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in Johannesburg as YYYY-MM-DD (en-CA formats dates that way). */
export function todayInJohannesburg(now: Date = new Date()): string {
  return isoDateFormatter.format(now);
}

/** True only for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
