import type { PageMeta } from './respond';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** page 1, size 20 → LIMIT 20 OFFSET 0 */
export function pageToLimitOffset(
  page: number,
  pageSize: number,
): { limit: number; offset: number } {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
