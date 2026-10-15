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
