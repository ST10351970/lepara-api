# Lepara Ale fele Moya API

The back end for the Lepara Ale fele Moya mobile app and website: Node.js, Express 5, TypeScript and a cloud PostgreSQL database. One API serves both apps; the admin dashboard on the website uses the `/api/v1/admin` routes added in later phases.

This is **Phase 1 (Foundation)** of the build guide: the project skeleton, the app shell with error handling, the database migrations and seeds, the shared building blocks, tests and CI.

## Requirements

- Node.js 22.12 or newer (Vitest 5 needs it)
- A PostgreSQL database. The project uses [Neon](https://neon.com) (cloud, free plan); a local or Docker PostgreSQL 16 also works
- Git

## First-time setup

```bash
npm install                 # creates package-lock.json: commit it (CI uses npm ci)
cp .env.example .env        # then fill in the values
```

**1. Create two databases**, one for development and one for tests. The test database name must end in `_test`, because the tests empty it.

On Neon: create a project, then under **Databases** add `lepara_dev` and `lepara_test`. Click **Connect**, choose each database, turn **Connection pooling off** (the migration runner needs a direct connection), and copy the connection string.

**2. Fill in `.env`**

- Remove everything from the `?` onwards in each connection string (`?sslmode=require&channel_binding=require`) and set `DATABASE_SSL=true` instead.
- `MIGRATION_DATABASE_URL` and, for now, `DATABASE_URL`: the `lepara_dev` string.
- `TEST_DATABASE_URL`: the `lepara_test` string.
- `SEED_ADMIN_*`: the first admin account for signing in to the API. If the password contains `#`, wrap it in double quotes.

**3. Create the tables**

```bash
npm run migrate:up
```

The first line it prints, `Database: ...`, shows which database it is using. If it says `localhost`, `.env` is not filled in or not saved.

**Before deploying: create the limited app user** the live API connects as (it cannot drop tables or delete records):

```bash
psql "<owner connection string>" -v app_password='<a long random password>' -f db/setup/create-app-user.sql
```

Then put `lepara_app` and that password in `DATABASE_URL`. Migrations and seeds keep using the owner in `MIGRATION_DATABASE_URL`.

**4. Add the starting data**

```bash
npm run seed:sample         # development: reference data, first super admin, sample events and products
npm run seed                # live database: reference data and first super admin only
```

**5. Start the API**

```bash
npm run dev
```

Open http://localhost:3000/api/v1/health. You should see `"status": "ok"` and `"database": "up"`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API and restarts it when you save a file |
| `npm run build` / `npm start` | Compiles to `dist/` / runs the compiled API |
| `npm test` | Runs all tests (database tests need `TEST_DATABASE_URL`) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint checks |
| `npm run migrate:up` | Applies migrations not yet applied |
| `npm run migrate:down` | Undoes the last migration (`-- 2` for two, `-- all` for everything in development) |
| `npm run migrate:status` | Lists applied and pending migrations |
| `npm run seed` / `npm run seed:sample` | Adds starting data; safe to run more than once |

## Checking Phase 1

`npm test` covers the "Done when" checks for steps 1 to 4 of the build guide:

| Check | Where it is tested |
| --- | --- |
| `/health` returns the success envelope, and 503 when the database is down | `tests/integration/health.test.ts`, `app.test.ts` |
| Malformed JSON gives a 400 envelope; oversized bodies 413; unknown paths 404 | `tests/integration/app.test.ts` |
| A missing environment variable stops start-up with a clear message | `tests/unit/env.test.ts` |
| Migrations undo and re-apply cleanly | `tests/setup/globalSetup.ts`, `tests/integration/database.test.ts` |
| Constraints reject bad rows (donation type rule, stock below zero, status values, linked records) | `tests/integration/database.test.ts` |
| Validation rules for names, emails, phone numbers, passwords, money, dates | `tests/unit/schemas.test.ts`, `tests/integration/requestHandling.test.ts` |
| Reference numbers never use 0, O, 1 or I and retry on a clash | `tests/unit/referenceNumber.test.ts` |
| Errors never expose stack traces; rate limits return 429 | `tests/integration/requestHandling.test.ts` |

To check by hand that the app user cannot drop a table, connect as `lepara_app` and run `DROP TABLE donation;`. It should fail with "must be owner of table donation".

## Deploying (Azure App Service or Render)

- **Runtime:** Node 22, Linux
- **Build command:** `npm ci --include=dev && npm run build && npm prune --omit=dev` (TypeScript is a dev dependency, so it must be installed to build)
- **Start command:** `npm start`
- **Health check path:** `/api/v1/health`
- **Environment variables:** `NODE_ENV=production`, `DATABASE_URL` (the `lepara_app` user), `DATABASE_SSL=true`, `TRUST_PROXY=1`, `CORS_ORIGINS` (the website's address), `LOG_LEVEL=info`. The host sets `PORT`.

Run `npm run migrate:up` from your own machine, with `MIGRATION_DATABASE_URL` pointing at the cloud database, before deploying code that needs new tables.

## How the code is organised

```
src/
  server.ts              starts the server, shuts down cleanly
  app.ts                 middleware order, routes, error handler
  routes.ts              mounts each module under /api/v1
  config/                environment check, database pool and transactions
  middleware/            validation, error handler, not-found, rate limits
  modules/<feature>/     routes → controller → service → repository (Task 1, Section 6.2)
  schemas/common.ts      shared validation rules with user-facing messages
  utils/                 errors, money in cents, dates, paging, reference numbers, safe sorting
db/
  migrations/            numbered SQL files, each with an up and a down section
  seeds/                 reference and sample data
  setup/                 the limited app user
tests/
  unit/                  pure logic, no database
  integration/           the HTTP app and the database
```

### Rules every module follows

- **SQL injection:** SQL is written in the code; user input only ever goes in the values array (`$1`, `$2`). Sort orders come from `pickSort`, never from user text.
- **Validation:** every route validates params, query and body with `validate()` before the controller runs.
- **Errors:** throw `AppError` (or use `errors.*`); never send an error response by hand.
- **Money:** whole cents everywhere; format with `formatRand` only for display.
- **Several tables in one change:** wrap it in `withTransaction()`.

## Changes to the Task 1 design

Migration `001` creates the ten Task 1 tables exactly as Section 8 designs them. Everything below was added in later migrations and should be recorded in the Task 1 design sections (ERD, class diagram):

| Migration | Change | Why |
| --- | --- | --- |
| 002 | `ADMIN_USER`: role, authenticator secret, 2FA flag, must-change-password, failed logins, lock time, last login; new `ADMIN_BACKUP_CODE` | Two-factor sign-in and lockout |
| 002 | `INITIATIVE`: summary, start and end time, donation needs, image; end date on or after start date | The app's event cards |
| 002 | New `INITIATIVE_TASK`; `VOLUNTEER_APPLICATION`: reference number, task, contribution description, consent | The app's volunteer form and tracking |
| 002 | Consent timestamp on `ASSISTANCE_REQUEST` and `ENQUIRY` | POPIA |
| 002 | New `DONATION_PLEDGE`; `DONATION`: pledge link, void date, voided by, void reason | The app's Give form; correcting donations without deleting them |
| 002 | `STOCK_ITEM`: unique name, reorder level | Low-stock alerts |
| 002 | `STOCK_MOVEMENT`: reason; a movement with no donation or request is allowed if it has a reason | Manual adjustments (damaged goods, recounts). This relaxes the Section 8.4 rule that every movement comes from a donation or a request |
| 002 | New `REFRESH_TOKEN`, `DEVICE_TOKEN`, `AUDIT_LOG` | Sessions, push notifications, who changed what |
| 003 | Customer accounts and shop: `CUSTOMER`, `VERIFICATION_CODE`, `PRODUCT_CATEGORY`, `PRODUCT`, `PRODUCT_VARIANT`, `CUSTOMER_ORDER`, `ORDER_ITEM`, `ORDER_STATUS_HISTORY`, `PAYMENT`, `IDEMPOTENCY_KEY` | The app's Account, Shop and Checkout screens |
| 004 | One pending volunteer application per phone number per initiative | Stops duplicate applications |
