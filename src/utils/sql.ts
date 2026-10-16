/**
 * Column names and sort directions cannot be sent as $1 placeholders, so a
 * sort order is chosen from a fixed list written in the code. Whatever the
 * user sends, only one of these strings can reach the SQL.
 *
 *   const SORTS = { newest: 'submitted_date DESC', oldest: 'submitted_date ASC' };
 *   const orderBy = pickSort(query.sort, SORTS, 'newest');
 *   `SELECT ... ORDER BY ${orderBy} LIMIT $1 OFFSET $2`
 */
export function pickSort<Key extends string>(
  requested: string | undefined,
  allowed: Record<Key, string>,
  fallback: Key,
): string {
  if (requested !== undefined && Object.prototype.hasOwnProperty.call(allowed, requested)) {
    return allowed[requested as Key];
  }
  return allowed[fallback];
}

/**
 * A search term for ILIKE that matches the text anywhere, with % and _ in
 * the user's text treated as ordinary characters. Pass it as a $ value:
 *   WHERE full_name ILIKE $1      values: [likeContains(search)]
 */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

// --- List filters shared by the admin lists ---------------------------------------------

/**
 * Date filters are whole days in Johannesburg: from 2026-10-01 to 2026-10-31
 * means 1 October 00:00 SAST up to the end of 31 October. `param` is a
 * placeholder such as '$4' holding a YYYY-MM-DD date or null (no limit).
 */
export const FROM_DAY = (column: string, param: string) =>
  `(${param}::date IS NULL OR ${column} >= (${param}::date::timestamp AT TIME ZONE 'Africa/Johannesburg'))`;
export const TO_DAY = (column: string, param: string) =>
  `(${param}::date IS NULL OR ${column} < ((${param}::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg'))`;

/**
 * A search box value as two patterns: one for text, and one for phone
 * numbers, which are stored as +27712345678 but typed as 071 234 5678.
 */
export function searchPatterns(search: string | undefined): {
  text: string | null;
  phone: string | null;
} {
  if (!search) return { text: null, phone: null };
  const digits = search.replace(/[\s()+-]/g, '');
  return {
    text: likeContains(search),
    phone: /^\d{3,}$/.test(digits) ? likeContains(digits) : null,
  };
}

/** Matches +27712345678 when 0712345678, 712345678 or 27712345678 is typed. */
export const PHONE_MATCH = (column: string, param: string) =>
  `(${param}::text IS NOT NULL AND (${column} ILIKE ${param} OR ('0' || substr(${column}, 4)) ILIKE ${param}))`;
