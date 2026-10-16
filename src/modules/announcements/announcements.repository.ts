import { type Queryable, pool, query } from '../../config/db';
import { likeContains } from '../../utils/sql';

/** Queries for announcements (the app's News screen). Values always go in as $1, $2, ... */

export type AnnouncementRow = {
  announcement_id: number;
  title: string;
  body: string;
  published_date: Date;
  is_active: boolean;
  published_by: number;
  published_by_name: string;
};

const COLUMNS = `n.announcement_id, n.title, n.body, n.published_date, n.is_active,
  n.published_by, a.full_name AS published_by_name`;
const FROM = 'FROM announcement n JOIN admin_user a ON a.admin_id = n.published_by';
const NEWEST_FIRST = 'ORDER BY n.published_date DESC, n.announcement_id DESC';

export async function listAnnouncements(filters: {
  isActive: boolean | null;
  search: string | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: AnnouncementRow[]; total: number }> {
  const where = `($1::boolean IS NULL OR n.is_active = $1)
    AND ($2::text IS NULL OR n.title ILIKE $2 OR n.body ILIKE $2)`;
  const values = [filters.isActive, filters.search ? likeContains(filters.search) : null];
  const [page, count] = await Promise.all([
    query<AnnouncementRow>(
      `SELECT ${COLUMNS} ${FROM} WHERE ${where} ${NEWEST_FIRST} LIMIT $3 OFFSET $4`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM announcement n WHERE ${where}`,
      values,
    ),
  ]);
  return { rows: page.rows, total: count.rows[0]?.total ?? 0 };
}

export async function findAnnouncement(
  announcementId: number,
  db: Queryable = pool,
): Promise<AnnouncementRow | null> {
  const { rows } = await query<AnnouncementRow>(
    `SELECT ${COLUMNS} ${FROM} WHERE n.announcement_id = $1`,
    [announcementId],
    db,
  );
  return rows[0] ?? null;
}

/** Locks the row until the transaction ends, so two edits can't overlap. */
export async function lockAnnouncement(db: Queryable, announcementId: number): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM announcement WHERE announcement_id = $1 FOR UPDATE',
    [announcementId],
    db,
  );
  return rows.length === 1;
}

export async function insertAnnouncement(
  db: Queryable,
  publishedBy: number,
  announcement: { title: string; body: string },
): Promise<number> {
  const { rows } = await query<{ announcement_id: number }>(
    `INSERT INTO announcement (published_by, title, body) VALUES ($1, $2, $3)
     RETURNING announcement_id`,
    [publishedBy, announcement.title, announcement.body],
    db,
  );
  return rows[0]!.announcement_id;
}

export async function updateAnnouncement(
  db: Queryable,
  announcementId: number,
  changes: { title?: string; body?: string },
): Promise<void> {
  await query(
    `UPDATE announcement
     SET title = COALESCE($2, title), body = COALESCE($3, body)
     WHERE announcement_id = $1`,
    [announcementId, changes.title ?? null, changes.body ?? null],
    db,
  );
}

export async function setAnnouncementActive(
  db: Queryable,
  announcementId: number,
  isActive: boolean,
): Promise<void> {
  await query(
    'UPDATE announcement SET is_active = $2 WHERE announcement_id = $1',
    [announcementId, isActive],
    db,
  );
}
