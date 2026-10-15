import { type Queryable, pool, query } from '../config/db';

/**
 * Records who did what, in audit_log. Pass the transaction's client so the
 * entry is saved together with the change, or not at all.
 * Never put passwords, codes or tokens in `details`.
 */
export type AuditEntry = {
  adminId: number;
  action: string;
  tableName: string;
  recordId: string | number;
  details?: Record<string, unknown>;
};

export async function recordAudit(entry: AuditEntry, db: Queryable = pool): Promise<void> {
  await query(
    `INSERT INTO audit_log (admin_id, action, table_name, record_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.adminId,
      entry.action,
      entry.tableName,
      String(entry.recordId),
      entry.details ? JSON.stringify(entry.details) : null,
    ],
    db,
  );
}
