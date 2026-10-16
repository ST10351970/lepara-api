import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/config/db';
import { signAccessToken } from '../../src/modules/adminAuth/adminAuth.tokens';
import { closeTestClient, testQuery } from '../helpers/db';
import { hasTestDatabase } from '../setup/testDatabase';

// Photos go to a pretend storage here, so the tests need no Azure account.
const storage = vi.hoisted(() => ({ saved: 0, deleted: [] as string[] }));
vi.mock('../../src/services/imageStorage', () => ({
  imageStorageReady: () => true,
  saveImage: async (_image: unknown, folder: string) => {
    storage.saved += 1;
    return `https://test.blob.core.windows.net/images/${folder}/${storage.saved}.png`;
  },
  deleteImage: async (url: string | null) => {
    if (url) storage.deleted.push(url);
  },
}));

const app = createApp();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const tag = randomUUID().slice(0, 6).toUpperCase();
let adminId = 0;
let auth = '';
let categoryId = 0;

const admin = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set('Authorization', auth),
  post: (path: string, body: object) =>
    request(app).post(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set('Authorization', auth).send(body),
};

/** The public shop, limited to this file's own category. */
const shop = (query: Record<string, string> = {}) =>
  request(app)
    .get('/api/v1/products')
    .query({ categoryId: String(categoryId), ...query });

async function newProduct(body: object = {}): Promise<number> {
  const res = await admin.post('/products', {
    categoryId,
    name: 'Community tee',
    colour: 'White',
    material: 'Cotton',
    price: 'R250',
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body.data.productId;
}

describe.skipIf(!hasTestDatabase)('shop', () => {
  beforeAll(async () => {
    const username = `test.${randomUUID().slice(0, 8)}`;
    const [row] = await testQuery<{ admin_id: number }>(
      `INSERT INTO admin_user (username, email, password_hash, full_name, role)
       VALUES ($1, $2, 'not-used', 'Shop Admin', 'staff') RETURNING admin_id`,
      [username, `${username}@example.com`],
    );
    adminId = row!.admin_id;
    auth = `Bearer ${signAccessToken(adminId, 0)}`;

    const category = await admin.post('/product-categories', { name: `Test category ${tag}` });
    expect(category.status).toBe(201);
    categoryId = category.body.data.categoryId;
  });

  afterAll(async () => {
    const products = await testQuery<{ product_id: number }>(
      'SELECT product_id FROM product WHERE category_id = $1',
      [categoryId],
    );
    const ids = products.map((row) => row.product_id);
    await testQuery('DELETE FROM product_variant WHERE product_id = ANY($1)', [ids]);
    await testQuery('DELETE FROM product WHERE product_id = ANY($1)', [ids]);
    await testQuery('DELETE FROM product_category WHERE category_id = $1', [categoryId]);
    await testQuery('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await testQuery('DELETE FROM admin_user WHERE admin_id = $1', [adminId]);
    await closeTestClient();
    await closePool();
  });

  it('hides inactive products from the public', async () => {
    const id = await newProduct({
      variants: [{ size: 'M', sku: `TEE-${tag}-M`, quantityOnHand: 5 }],
    });
    // New products start hidden.
    expect((await shop()).body.data).toEqual([]);
    expect((await request(app).get(`/api/v1/products/${id}`)).status).toBe(404);

    expect((await admin.patch(`/products/${id}`, { isActive: true })).status).toBe(200);
    expect((await shop()).body.data.map((p: { productId: number }) => p.productId)).toEqual([id]);

    expect((await admin.patch(`/products/${id}`, { isActive: false })).status).toBe(200);
    expect((await shop()).body.data).toEqual([]);
    expect((await request(app).get(`/api/v1/products/${id}`)).status).toBe(404);
  });

  it("treats a search for '; DROP TABLE product; -- as ordinary text", async () => {
    const res = await request(app)
      .get('/api/v1/products')
      .query({ search: "'; DROP TABLE product; --" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // The table is still there.
    const rows = await testQuery('SELECT 1 FROM product LIMIT 1');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('shows prices, sizes and stock as words for the app', async () => {
    const id = await newProduct({
      name: 'Everyday hoodie',
      colour: 'Black',
      material: 'Cotton blend',
      price: 550,
      isActive: true,
      variants: [
        { size: 'XL', sku: `HOOD-${tag}-XL`, quantityOnHand: 10 },
        { size: 'S', sku: `HOOD-${tag}-S`, quantityOnHand: 2 },
        { size: 'M', sku: `HOOD-${tag}-M`, quantityOnHand: 0 },
      ],
    });

    const card = (await shop({ search: 'hoodie' })).body.data[0];
    expect(card).toMatchObject({
      productId: id,
      price: 'R550',
      priceCents: 55_000,
      subtitle: 'Black / Cotton blend / S–XL',
      sizes: ['S', 'M', 'XL'],
      inStock: true,
    });

    const page = await request(app).get(`/api/v1/products/${id}`);
    expect(
      page.body.data.variants.map((v: { size: string; availability: string }) => [
        v.size,
        v.availability,
      ]),
    ).toEqual([
      ['S', 'Low stock'],
      ['M', 'Sold out'],
      ['XL', 'In stock'],
    ]);
    // Exact numbers and SKU codes are for the dashboard only.
    expect(JSON.stringify(page.body)).not.toMatch(/quantityOnHand|"sku"|isActive/);

    const dashboard = await admin.get(`/products/${id}`);
    expect(dashboard.body.data).toMatchObject({ totalStock: 12, isActive: true });
  });

  it('only shows a product once it has a size', async () => {
    const tooSoon = await admin.post('/products', {
      categoryId,
      name: 'Together tote',
      price: 180,
      isActive: true,
    });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.error.fields[0].field).toBe('isActive');

    const id = await newProduct({ name: 'Together tote', price: 180 });
    expect((await admin.patch(`/products/${id}`, { isActive: true })).status).toBe(400);
    const sized = await admin.post(`/products/${id}/variants`, {
      size: 'One size',
      sku: `TOTE-${tag}`,
      quantityOnHand: 3,
    });
    expect(sized.status).toBe(201);
    expect((await admin.patch(`/products/${id}`, { isActive: true })).status).toBe(200);
  });

  it('keeps sizes and SKU codes unique', async () => {
    const id = await newProduct({ variants: [{ size: 'L', sku: `UNQ-${tag}-L` }] });

    const sameSize = await admin.post(`/products/${id}/variants`, {
      size: 'L',
      sku: `UNQ-${tag}-L2`,
    });
    expect(sameSize.status).toBe(409);
    expect(sameSize.body.error.fields[0].field).toBe('size');

    const sameSku = await admin.post(`/products/${id}/variants`, {
      size: 'XL',
      sku: `unq-${tag}-l`, // capitals don't matter
    });
    expect(sameSku.status).toBe(409);
    expect(sameSku.body.error.fields[0].field).toBe('sku');
  });

  it('updates stock and records it', async () => {
    const id = await newProduct({
      variants: [{ size: 'S', sku: `STK-${tag}-S`, quantityOnHand: 1 }],
    });
    const product = await admin.get(`/products/${id}`);
    const variantId = product.body.data.variants[0].variantId;

    const restocked = await admin.patch(`/products/${id}/variants/${variantId}`, {
      quantityOnHand: 20,
    });
    expect(restocked.status).toBe(200);
    expect(restocked.body.data.totalStock).toBe(20);

    const [entry] = await testQuery<{ details: unknown }>(
      `SELECT details FROM audit_log WHERE action = 'variant_updated' AND record_id = $1`,
      [String(variantId)],
    );
    expect(entry!.details).toEqual({
      productId: id,
      size: 'S',
      quantityOnHand: { from: 1, to: 20 },
    });
  });

  it('checks product photos and replaces the old one', async () => {
    const id = await newProduct();
    const upload = (buffer: Buffer, filename: string, contentType: string) =>
      request(app)
        .post(`/api/v1/admin/products/${id}/image`)
        .set('Authorization', auth)
        .attach('image', buffer, { filename, contentType });

    expect((await upload(Buffer.from('not a photo'), 'tee.png', 'image/png')).status).toBe(415);
    const first = await upload(PNG, 'tee.png', 'image/png');
    expect(first.status).toBe(200);
    expect(first.body.data.imageUrl).toMatch(/\/images\/products\//);
    await upload(PNG, 'tee-2.png', 'image/png');
    expect(storage.deleted).toContain(first.body.data.imageUrl);
  });

  it('lists categories for everyone and keeps their names unique', async () => {
    const list = await request(app).get('/api/v1/product-categories');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId, name: `Test category ${tag}` }),
      ]),
    );
    const duplicate = await admin.post('/product-categories', { name: `TEST CATEGORY ${tag}` });
    expect(duplicate.status).toBe(409);
  });

  it('checks prices and keeps the dashboard behind sign-in', async () => {
    const free = await admin.post('/products', { categoryId, name: 'Free tee', price: 0 });
    expect(free.status).toBe(400);
    expect(free.body.error.fields).toEqual([
      { field: 'price', message: 'The price must be more than R0.' },
    ]);
    expect((await request(app).get('/api/v1/admin/products')).status).toBe(401);
  });
});
