import { afterAll, describe, expect, it } from 'vitest';
import { scriptConnectionConfig } from '../../db/connection';
import { migrateDown, migrateUp, migrationStatus } from '../../db/migrate';
import { mapDatabaseError } from '../../src/utils/pgErrors';
import { closeTestClient, errorFrom, insertFixtures, withRollback } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

afterAll(async () => {
  await closeTestClient();
});

/**
 * The database protects its own data: these rows must be refused even if the
 * API code had a bug. Each test runs in a transaction that is rolled back.
 */
describe.skipIf(!hasTestDatabase)('database constraints', () => {
  it('rejects a monetary donation that also records goods (Task 1, Section 8.4)', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO donation (recorded_by, donor_name, donation_type, amount, quantity, date_received)
           VALUES ($1, 'Donor', 'Monetary', 100, 5, '2026-10-01')`,
          [f.adminId],
        ),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'donation_type_columns_check' });
      expect(mapDatabaseError(error)?.status).toBe(400);
    });
  });

  it('rejects a goods donation with no stock item', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO donation (recorded_by, donor_name, donation_type, quantity, date_received)
           VALUES ($1, 'Donor', 'Goods', 5, '2026-10-01')`,
          [f.adminId],
        ),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'donation_type_columns_check' });
    });
  });

  it('rejects a stock movement linked to both a donation and a request', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO stock_movement (stock_item_id, donation_id, request_id, recorded_by, movement_type, quantity)
           VALUES ($1, $2, $3, $4, 'Increase', 1)`,
          [f.stockItemId, f.monetaryDonationId, f.requestId, f.adminId],
        ),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'stock_movement_source_check' });
    });
  });

  it('accepts a manual stock adjustment only with a reason', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const sql = `INSERT INTO stock_movement (stock_item_id, recorded_by, movement_type, quantity, reason)
                   VALUES ($1, $2, 'Increase', 3, $3)`;
      await expect(
        db.query(sql, [f.stockItemId, f.adminId, 'Recount after the drive']),
      ).resolves.toBeTruthy();
      const error = await errorFrom(db.query(sql, [f.stockItemId, f.adminId, null]));
      expect(error).toMatchObject({ code: '23514', constraint: 'stock_movement_source_check' });
    });
  });

  it('never lets stock go below zero', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query('UPDATE stock_item SET quantity_on_hand = -1 WHERE stock_item_id = $1', [
          f.stockItemId,
        ]),
      );
      expect(error).toMatchObject({
        code: '23514',
        constraint: 'stock_item_quantity_on_hand_check',
      });
    });
  });

  it('only allows the status values from the Task 1 state machines', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(`UPDATE initiative SET status = 'Pending' WHERE initiative_id = $1`, [
          f.initiativeId,
        ]),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'initiative_status_check' });
    });
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(`UPDATE assistance_request SET status = 'Done' WHERE request_id = $1`, [
          f.requestId,
        ]),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'assistance_request_status_check' });
    });
  });

  it('rejects an initiative that ends before it starts', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(`UPDATE initiative SET end_date = '2026-01-01' WHERE initiative_id = $1`, [
          f.initiativeId,
        ]),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'initiative_dates_check' });
    });
  });

  it('refuses to delete an admin whose records others rely on', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query('DELETE FROM admin_user WHERE admin_id = $1', [f.adminId]),
      );
      // PostgreSQL 16-17 report 23503; PostgreSQL 18+ report 23001 for ON DELETE RESTRICT.
      expect(['23503', '23001']).toContain(error.code);
      expect(mapDatabaseError(error)?.status).toBe(409);
    });
  });

  it('rejects a volunteer task that belongs to a different initiative', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO volunteer_application (initiative_id, applicant_name, contact_number, status,
                                              reference_number, initiative_task_id, consent_given_at)
           VALUES ($1, 'Volunteer', '+27711111111', 'Submitted', 'VOL-TASKXX', $2, now())`,
          [f.initiativeId, f.otherInitiativeTaskId],
        ),
      );
      expect(error).toMatchObject({ code: '23503', constraint: 'volunteer_application_task_fkey' });
    });
  });

  it('allows one pending application per phone number per initiative', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const apply = (reference: string) =>
        db.query(
          `INSERT INTO volunteer_application (initiative_id, applicant_name, contact_number, status,
                                              reference_number, consent_given_at)
           VALUES ($1, 'Volunteer', '+27711111111', 'Submitted', $2, now())`,
          [f.initiativeId, reference],
        );
      await apply('VOL-FIRSTX');
      const error = await errorFrom(apply('VOL-SECOND'));
      expect(error).toMatchObject({
        code: '23505',
        constraint: 'volunteer_application_pending_key',
      });
    });
  });

  it('requires consent on public submissions', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO volunteer_application (initiative_id, applicant_name, contact_number, status, reference_number)
           VALUES ($1, 'Volunteer', '+27712222222', 'Submitted', 'VOL-NOCONS')`,
          [f.initiativeId],
        ),
      );
      expect(error).toMatchObject({ code: '23502' });
    });
  });

  it('rejects an order whose total is not subtotal plus delivery', async () => {
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const insertOrder = (total: number) =>
        db.query<{ order_number: string }>(
          `INSERT INTO customer_order (customer_id, status, payment_method, recipient_name, street_address,
                                       city, postal_code, phone, subtotal_cents, delivery_cents, total_cents)
           VALUES ($1, 'Confirmed', 'EFT', 'Customer', '1 Vilakazi St', 'Soweto', '1804', '+27711234567',
                   25000, 6000, $2)
           RETURNING order_number`,
          [f.customerId, total],
        );
      const error = await errorFrom(insertOrder(30000));
      expect(error).toMatchObject({ code: '23514', constraint: 'customer_order_total_check' });
    });
    await withRollback(async (db) => {
      const f = await insertFixtures(db);
      const created = await db.query<{ order_number: string }>(
        `INSERT INTO customer_order (customer_id, status, payment_method, recipient_name, street_address,
                                     city, postal_code, phone, subtotal_cents, delivery_cents, total_cents)
         VALUES ($1, 'Confirmed', 'EFT', 'Customer', '1 Vilakazi St', 'Soweto', '1804', '+27711234567',
                 25000, 6000, 31000)
         RETURNING order_number`,
        [f.customerId],
      );
      expect(created.rows[0]?.order_number).toMatch(/^LAFM-\d{4,}$/);
    });
  });

  it('allows one customer account per email, ignoring capitals', async () => {
    await withRollback(async (db) => {
      await insertFixtures(db);
      const error = await errorFrom(
        db.query(
          `INSERT INTO customer (first_name, last_name, email, mobile, password_hash, terms_accepted_at)
           VALUES ('Other', 'Person', 'CUSTOMER@example.com', '+27712222222', 'x', now())`,
        ),
      );
      expect(error).toMatchObject({ code: '23505', constraint: 'customer_email_key' });
    });
  });
});

describe.skipIf(!hasTestDatabase)('migrations', () => {
  // Rebuilding every table takes a while on a cloud database, so this test gets 3 minutes.
  it('undo completely and re-apply cleanly', { timeout: 180_000 }, async () => {
    const config = scriptConnectionConfig(process.env.TEST_DATABASE_URL);
    const before = await migrationStatus(config);
    expect(before.pending).toEqual([]);

    const undone = await migrateDown(config, Number.POSITIVE_INFINITY);
    expect(undone).toEqual([...before.applied].reverse());
    expect((await migrationStatus(config)).applied).toEqual([]);

    const reapplied = await migrateUp(config);
    expect(reapplied).toEqual(before.applied);
  });
});
