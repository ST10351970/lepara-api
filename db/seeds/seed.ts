import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { z } from 'zod';
import { emailAddress, password, personName } from '../../src/schemas/common';
import { describeDatabase, explainScriptError, scriptConnectionConfig } from '../connection';
import {
  INITIATIVE_TYPES,
  PRODUCT_CATEGORIES,
  SAMPLE_INITIATIVES,
  SAMPLE_PRODUCTS,
  SAMPLE_STOCK_PER_SIZE,
  STOCK_ITEMS,
} from './data';

/**
 *   npm run seed           reference data + the first super admin (safe for the live database)
 *   npm run seed:sample    the same, plus sample initiatives and products for demos
 *
 * Safe to run more than once: anything already there is left alone.
 */

const seedAdminSchema = z.object({
  SEED_ADMIN_USERNAME: z
    .string({ error: 'is required' })
    .trim()
    .regex(
      /^[a-z0-9._-]{3,50}$/,
      'must be 3 to 50 lower-case letters, numbers, dots, dashes or underscores',
    ),
  SEED_ADMIN_EMAIL: emailAddress,
  SEED_ADMIN_FULL_NAME: personName('the full name', 150),
  SEED_ADMIN_PASSWORD: password,
});

async function seedReferenceData(client: Client): Promise<void> {
  for (const type of INITIATIVE_TYPES) {
    await client.query(
      `INSERT INTO initiative_type (type_name, description) VALUES ($1, $2)
       ON CONFLICT (type_name) DO NOTHING`,
      [type.name, type.description],
    );
  }
  for (const item of STOCK_ITEMS) {
    await client.query(
      `INSERT INTO stock_item (item_name, category, unit_of_measure, reorder_level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_name) DO NOTHING`,
      [item.name, item.category, item.unit, item.reorderLevel],
    );
  }
  for (const [index, name] of PRODUCT_CATEGORIES.entries()) {
    await client.query(
      `INSERT INTO product_category (name, sort_order) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [name, index],
    );
  }
  console.log('  reference data: initiative types, stock items, product categories');
}

async function seedSuperAdmin(client: Client): Promise<number> {
  const existing = await client.query<{ admin_id: number }>(
    `SELECT admin_id FROM admin_user WHERE role = 'super_admin' ORDER BY admin_id LIMIT 1`,
  );
  if (existing.rows[0]) {
    console.log('  super admin: already exists, left unchanged');
    return existing.rows[0].admin_id;
  }

  const parsed = seedAdminSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(
      `Set the SEED_ADMIN_* values in .env to create the first super admin:\n  ${problems}`,
    );
  }

  const admin = parsed.data;
  const passwordHash = await bcrypt.hash(admin.SEED_ADMIN_PASSWORD, 12);
  const result = await client.query<{ admin_id: number }>(
    `INSERT INTO admin_user (username, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, 'super_admin')
     RETURNING admin_id`,
    [admin.SEED_ADMIN_USERNAME, admin.SEED_ADMIN_EMAIL, passwordHash, admin.SEED_ADMIN_FULL_NAME],
  );
  console.log(
    `  super admin: created "${admin.SEED_ADMIN_USERNAME}" (2FA is set up at first sign-in)`,
  );
  return result.rows[0]!.admin_id;
}

async function seedSampleData(client: Client, adminId: number): Promise<void> {
  for (const initiative of SAMPLE_INITIATIVES) {
    const exists = await client.query('SELECT 1 FROM initiative WHERE title = $1', [
      initiative.title,
    ]);
    if (exists.rowCount) continue;

    const inserted = await client.query<{ initiative_id: number }>(
      `INSERT INTO initiative (
         initiative_type_id, created_by, title, summary, description, location,
         start_date, end_date, start_time, end_time, donation_needs, volunteers_required, status)
       SELECT initiative_type_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       FROM initiative_type WHERE type_name = $1
       RETURNING initiative_id`,
      [
        initiative.type,
        adminId,
        initiative.title,
        initiative.summary,
        initiative.description,
        initiative.location,
        initiative.startDate,
        initiative.endDate,
        initiative.startTime,
        initiative.endTime,
        initiative.donationNeeds,
        initiative.volunteersRequired,
        initiative.status,
      ],
    );
    const initiativeId = inserted.rows[0]!.initiative_id;
    for (const task of initiative.tasks) {
      await client.query('INSERT INTO initiative_task (initiative_id, task_name) VALUES ($1, $2)', [
        initiativeId,
        task,
      ]);
    }
  }

  for (const product of SAMPLE_PRODUCTS) {
    const exists = await client.query('SELECT 1 FROM product WHERE name = $1', [product.name]);
    if (exists.rowCount) continue;

    const inserted = await client.query<{ product_id: number }>(
      `INSERT INTO product (category_id, name, colour, material, price_cents)
       SELECT category_id, $2, $3, $4, $5 FROM product_category WHERE name = $1
       RETURNING product_id`,
      [product.category, product.name, product.colour, product.material, product.priceCents],
    );
    const productId = inserted.rows[0]!.product_id;
    for (const size of product.sizes) {
      const sku = `${product.skuPrefix}-${size === 'One size' ? 'OS' : size}`;
      await client.query(
        `INSERT INTO product_variant (product_id, size, sku, quantity_on_hand) VALUES ($1, $2, $3, $4)
         ON CONFLICT (sku) DO NOTHING`,
        [productId, size, sku, SAMPLE_STOCK_PER_SIZE],
      );
    }
  }
  console.log('  sample data: 4 initiatives with volunteer tasks, 3 products with sizes');
}

async function main(): Promise<void> {
  const withSample = process.argv.includes('--sample');
  const config = scriptConnectionConfig();
  console.log(`Seeding ${describeDatabase(String(config.connectionString))}`);

  const client = new Client(config);
  await client.connect();
  try {
    await client.query('BEGIN');
    await seedReferenceData(client);
    const adminId = await seedSuperAdmin(client);
    if (withSample) await seedSampleData(client, adminId);
    await client.query('COMMIT');
    console.log('Done.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  console.error(`\n${explainScriptError(error, url)}\n`);
  process.exit(1);
});
