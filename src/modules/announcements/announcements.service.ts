import { type Queryable, withTransaction } from '../../config/db';
import { announcementPublished } from '../../services/notifications';
import { errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { todayInJohannesburg } from '../../utils/dates';
import { logger } from '../../utils/logger';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import type { PageMeta } from '../../utils/respond';
import { formatDateLabel } from '../initiatives/initiatives.format';
import * as repo from './announcements.repository';
import type { AnnouncementRow } from './announcements.repository';
import type {
  AdminListQuery,
  CreateAnnouncementInput,
  PublicListQuery,
  UpdateAnnouncementInput,
} from './announcements.schemas';

/**
 * Announcements (the app's News screen).
 *  - Published the moment they are created; there are no drafts (Task 1).
 *  - Hiding one (isActive false) removes it from the app straight away;
 *    showing it again puts it back in its original place.
 *  - Newest first everywhere. Every change goes in the audit log.
 */

/** One item on the News screen. */
export type PublicAnnouncement = {
  announcementId: number;
  title: string;
  body: string;
  publishedAt: Date;
  /** The publishing date in Johannesburg, such as "16 Oct 2026". */
  dateLabel: string;
};

export type AdminAnnouncement = PublicAnnouncement & {
  isActive: boolean;
  publishedBy: { adminId: number; fullName: string };
};

function toPublic(row: AnnouncementRow): PublicAnnouncement {
  const day = todayInJohannesburg(row.published_date); // the date in Johannesburg, as YYYY-MM-DD
  return {
    announcementId: row.announcement_id,
    title: row.title,
    body: row.body,
    publishedAt: row.published_date,
    dateLabel: formatDateLabel(day, day),
  };
}

function toAdmin(row: AnnouncementRow): AdminAnnouncement {
  return {
    ...toPublic(row),
    isActive: row.is_active,
    publishedBy: { adminId: row.published_by, fullName: row.published_by_name },
  };
}

const notFound = () => errors.notFound("We couldn't find that announcement.");

const audit = (
  db: Queryable,
  adminId: number,
  action: string,
  announcementId: number,
  details?: Record<string, unknown>,
) =>
  recordAudit(
    { adminId, action, tableName: 'announcement', recordId: announcementId, details },
    db,
  );

// --- Public ---------------------------------------------------------------------

/** Shown announcements only, newest first. */
export async function listPublicAnnouncements(
  filters: PublicListQuery,
): Promise<{ items: PublicAnnouncement[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listAnnouncements({
    isActive: true,
    search: undefined,
    limit,
    offset,
  });
  return { items: rows.map(toPublic), meta: pageMeta(filters.page, filters.pageSize, total) };
}

// --- Admin ----------------------------------------------------------------------

export async function listAdminAnnouncements(
  filters: AdminListQuery,
): Promise<{ items: AdminAnnouncement[]; meta: PageMeta }> {
  const { limit, offset } = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listAnnouncements({
    isActive: filters.status === 'all' ? null : filters.status === 'active',
    search: filters.search,
    limit,
    offset,
  });
  return { items: rows.map(toAdmin), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function getAdminAnnouncement(announcementId: number): Promise<AdminAnnouncement> {
  const row = await repo.findAnnouncement(announcementId);
  if (!row) throw notFound();
  return toAdmin(row);
}

/** Publishes a new announcement, then tells the app (push notifications arrive in step 17). */
export async function createAnnouncement(
  adminId: number,
  input: CreateAnnouncementInput,
): Promise<AdminAnnouncement> {
  const row = await withTransaction(async (client) => {
    const announcementId = await repo.insertAnnouncement(client, adminId, input);
    await audit(client, adminId, 'announcement_published', announcementId);
    return (await repo.findAnnouncement(announcementId, client))!;
  });
  try {
    await announcementPublished({ announcementId: row.announcement_id, title: row.title });
  } catch (error) {
    // The announcement is saved either way; a failed notification must not undo it.
    logger.warn({ err: error }, 'Could not send the announcement notification');
  }
  return toAdmin(row);
}

/** Corrects the title or text. The publishing date stays the same. */
export async function updateAnnouncement(
  adminId: number,
  announcementId: number,
  input: UpdateAnnouncementInput,
): Promise<AdminAnnouncement> {
  const row = await withTransaction(async (client) => {
    if (!(await repo.lockAnnouncement(client, announcementId))) throw notFound();
    const current = (await repo.findAnnouncement(announcementId, client))!;
    const changes: { title?: string; body?: string } = {};
    if (input.title !== undefined && input.title !== current.title) changes.title = input.title;
    if (input.body !== undefined && input.body !== current.body) changes.body = input.body;
    if (Object.keys(changes).length === 0) return current;

    await repo.updateAnnouncement(client, announcementId, changes);
    await audit(client, adminId, 'announcement_updated', announcementId, {
      changed: Object.keys(changes),
    });
    return (await repo.findAnnouncement(announcementId, client))!;
  });
  return toAdmin(row);
}

/** Hides an announcement from the app, or shows it again. */
export async function setAnnouncementActive(
  adminId: number,
  announcementId: number,
  isActive: boolean,
): Promise<AdminAnnouncement> {
  const row = await withTransaction(async (client) => {
    if (!(await repo.lockAnnouncement(client, announcementId))) throw notFound();
    const current = (await repo.findAnnouncement(announcementId, client))!;
    if (current.is_active === isActive) return current;

    await repo.setAnnouncementActive(client, announcementId, isActive);
    await audit(
      client,
      adminId,
      isActive ? 'announcement_shown' : 'announcement_hidden',
      announcementId,
    );
    return (await repo.findAnnouncement(announcementId, client))!;
  });
  return toAdmin(row);
}
