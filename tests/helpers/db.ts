import { Client, type QueryResultRow } from 'pg';
import { scriptConnectionConfig } from '../../db/connection';

/**
 * One connection shared by the tests in a file. Opening a secure connection to
 * a cloud database takes about a second, so reusing it keeps the tests quick.
 */
let shared: Promise<Client> | undefined;

function testClient(): Promise<Client> {
  shared ??= (async () => {
    const client = new Client(scriptConnectionConfig(process.env.TEST_DATABASE_URL));
    await client.connect();
    return client;
  })();
  return shared;
}

/**
 * Runs one query that is kept (not rolled back). For tests where the API
 * itself must see the rows, such as signing in; clean up in afterAll.
 */
export async function testQuery<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const client = await testClient();
  return (await client.query<Row>(text, values)).rows;
}

/** Call from afterAll in any test file that uses withRollback or testQuery. */
export async function closeTestClient(): Promise<void> {
  if (!shared) return;
  const client = await shared.catch(() => undefined);
  shared = undefined;
  await client?.end();
}

/**
 * Runs `work` inside a transaction that is always rolled back, so each test
 * leaves the test database exactly as it found it.
 */
export async function withRollback<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await testClient();
  await client.query('BEGIN');
  try {
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

/** Returns the error a query throws, or fails the test if it does not throw. */
export async function errorFrom(
  promise: Promise<unknown>,
): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('Expected the database to reject this, but it was accepted.');
}

export type Fixtures = {
  adminId: number;
  typeId: number;
  initiativeId: number;
  otherInitiativeId: number;
  otherInitiativeTaskId: number;
  stockItemId: number;
  requestId: number;
  monetaryDonationId: number;
  customerId: number;
};

/** A small set of valid rows the constraint tests build on. */
export async function insertFixtures(client: Client): Promise<Fixtures> {
  const one = async (sql: string, values: unknown[]) => {
    const result = await client.query<{ id: number }>(sql, values);
    return result.rows[0]!.id;
  };

  const adminId = await one(
    `INSERT INTO admin_user (username, email, password_hash, full_name)
     VALUES ($1, $2, $3, $4) RETURNING admin_id AS id`,
    ['fixture.admin', 'admin@example.com', 'not-a-real-hash', 'Fixture Admin'],
  );
  const typeId = await one(
    `INSERT INTO initiative_type (type_name) VALUES ($1) RETURNING initiative_type_id AS id`,
    ['Fixture type'],
  );
  const insertInitiative = (title: string, date: string) =>
    one(
      `INSERT INTO initiative (initiative_type_id, created_by, title, description, start_date, end_date,
                               volunteers_required, status)
       VALUES ($1, $2, $3, $4, $5, $5, true, 'Published') RETURNING initiative_id AS id`,
      [typeId, adminId, title, 'Fixture initiative', date],
    );
  const initiativeId = await insertInitiative('Fixture drive', '2026-10-24');
  const otherInitiativeId = await insertInitiative('Other fixture drive', '2026-11-07');
  const otherInitiativeTaskId = await one(
    `INSERT INTO initiative_task (initiative_id, task_name) VALUES ($1, $2) RETURNING initiative_task_id AS id`,
    [otherInitiativeId, 'Clothing sorting'],
  );
  const stockItemId = await one(
    `INSERT INTO stock_item (item_name, unit_of_measure) VALUES ($1, $2) RETURNING stock_item_id AS id`,
    ['Fixture blankets', 'blanket'],
  );
  const requestId = await one(
    `INSERT INTO assistance_request (reference_number, applicant_name, contact_number, request_type,
                                     description, status, consent_given_at)
     VALUES ($1, $2, $3, $4, $5, 'Submitted', now()) RETURNING request_id AS id`,
    ['REQ-FIXTUR', 'Fixture Applicant', '+27711234567', 'Clothing', 'Needs warm clothing'],
  );
  const monetaryDonationId = await one(
    `INSERT INTO donation (recorded_by, donor_name, donation_type, amount, date_received)
     VALUES ($1, $2, 'Monetary', $3, $4) RETURNING donation_id AS id`,
    [adminId, 'Fixture Donor', '250.00', '2026-10-01'],
  );
  const customerId = await one(
    `INSERT INTO customer (first_name, last_name, email, mobile, password_hash, terms_accepted_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING customer_id AS id`,
    ['Fixture', 'Customer', 'customer@example.com', '+27711234567', 'not-a-real-hash'],
  );

  return {
    adminId,
    typeId,
    initiativeId,
    otherInitiativeId,
    otherInitiativeTaskId,
    stockItemId,
    requestId,
    monetaryDonationId,
    customerId,
  };
}
