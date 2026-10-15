# Lepara Ale fele Moya API

The back end for the Lepara Ale fele Moya mobile app and website: Node.js, Express 5, TypeScript and a cloud PostgreSQL database. One API serves both apps; the admin dashboard on the website uses the `/api/v1/admin` routes added in later phases.

Built so far, following the build guide:

- **Phase 1 (Foundation):** the project skeleton, the app shell with error handling, the database migrations and seeds, the shared building blocks, tests and CI.
- **Phase 2, Step 5:** admin sign-in with an authenticator app (two-factor authentication), sessions, lockout and password change.
- **Phase 2, Step 6:** admin user management: super admins add, edit and deactivate admins, and reset a lost authenticator or a forgotten password.

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
- `JWT_ADMIN_SECRET` and `TOTP_ENCRYPTION_KEY`: make each one with the command shown above it in `.env.example`, and paste the output. Use different values on your machine and on the live server.

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

## Admin sign-in (for the website team)

Admins sign in on the website only. Every admin endpoint is under `/api/v1/admin`.

| Step | Request | Reply (`data`) |
| --- | --- | --- |
| 1. Password | `POST /admin/auth/login` `{ username, password }` | `{ nextStep, pendingToken, expiresIn }`. `nextStep` is `two_factor_setup` the first time, `two_factor_verify` after that |
| 2a. First time: show the QR code | `POST /admin/auth/2fa/setup` `{ pendingToken }` | `{ qrCodeDataUrl, otpauthUrl, manualEntryKey }`. Show `qrCodeDataUrl` as an `<img>`; `manualEntryKey` is for typing in instead |
| 2a. First time: confirm | `POST /admin/auth/2fa/confirm` `{ pendingToken, code }` | A session (below) plus `backupCodes`: show these 10 codes once and ask the admin to keep them safe |
| 2b. Later sign-ins | `POST /admin/auth/2fa/verify` `{ pendingToken, code }` | A session. `code` is the 6 digits from the app, or a backup code |
| Stay signed in | `POST /admin/auth/refresh` (no body) | A new session. Call it when a request fails with `TOKEN_EXPIRED`, and on page load |
| Sign out | `POST /admin/auth/logout` | `{ signedOut: true }` |
| Sign out everywhere | `POST /admin/auth/logout-all` (needs the access token) | `{ signedOut: true }` |
| Who am I | `GET /admin/me` | The admin's profile |
| Change password | `PATCH /admin/me/password` `{ currentPassword, newPassword, confirmPassword }` | A new session; other devices are signed out |

A **session** is `{ accessToken, tokenType: "Bearer", expiresIn: 900, admin }`. `admin` holds `adminId`, `username`, `fullName`, `email`, `role`, `twoFactorEnabled`, `mustChangePassword`, `lastLoginAt` and `backupCodesRemaining`.

How the website should use it:

- **Keep the access token in memory only** (a variable or React state), not in localStorage. Send it as `Authorization: Bearer <accessToken>`. It lasts 15 minutes.
- **The refresh token is never in a reply.** The API puts it in an httpOnly cookie that JavaScript cannot read. Call the `/admin/auth/*` endpoints with `fetch(url, { credentials: 'include' })` so the browser sends and stores that cookie.
- **Refresh one at a time.** If several requests fail with `TOKEN_EXPIRED` together, make one refresh call and let them all wait for it.
- If `admin.mustChangePassword` is true, show the change-password page first. Other admin endpoints answer `403 PASSWORD_CHANGE_REQUIRED` until the password is changed.
- Error codes to handle: `UNAUTHORIZED` (go to sign-in), `TOKEN_EXPIRED` (refresh, then retry), `ACCOUNT_LOCKED` (423: show the message), `VALIDATION_ERROR` (show `fields` under the inputs).

Security rules built in:

- Five wrong passwords **or codes** in a row lock the account for 15 minutes.
- Each authenticator code works once. Each backup code works once.
- Authenticator secrets are stored encrypted (AES-256-GCM); backup codes and refresh tokens are stored only as hashes.
- Sessions last at most 12 hours. The refresh token is replaced every time it is used. If an old one is used again, someone has copied it, so the API signs that admin out on every device.
- Sign-in endpoints refuse browser requests from websites not listed in `CORS_ORIGINS`.

To try it by hand, run `npm run dev` and send the requests above with Thunder Client (a VS Code extension) or Postman. Scan the QR code with Google Authenticator or Microsoft Authenticator. To see the QR code, paste the whole `qrCodeDataUrl` value into a browser's address bar.

## Managing admins (super admins only)

Staff admins get `403 FORBIDDEN` on all of these.

| Request | What it does |
| --- | --- |
| `GET /admin/users?status=active\|inactive\|all&search=&page=&pageSize=` | Lists admins, active ones first. `search` looks in the username, name and email |
| `GET /admin/users/:id` | One admin |
| `POST /admin/users` `{ username, fullName, email, role }` | Adds an admin (`role` is `staff` unless set to `super_admin`). Replies with `{ admin, temporaryPassword }` |
| `PATCH /admin/users/:id` `{ fullName?, email?, role?, isActive? }` | Changes details, role or status. `isActive: false` deactivates the admin and ends their sessions at once |
| `POST /admin/users/:id/reset-2fa` | For a lost phone: removes their authenticator app and backup codes, and signs them out. Their next sign-in sets up 2FA again |
| `POST /admin/users/:id/reset-password` | For a forgotten password: replies with `{ admin, temporaryPassword }` and signs them out |

Each admin in a reply has `adminId`, `username`, `fullName`, `email`, `role`, `isActive`, `twoFactorEnabled`, `mustChangePassword`, `lockedUntil` (set while locked after wrong attempts), `lastLoginAt` and `createdAt`.

- **Temporary passwords are shown once.** The website should display the password with a copy button and a note to pass it on privately. The API never shows it again. At first sign-in the new admin sets up their authenticator app, then must choose their own password.
- **Rules:** usernames and emails must be unique, and usernames can't be changed later. Nobody can deactivate themselves or change their own role. There is always at least one active super admin; a request that would remove the last one gets `409`.
- **Audit log:** every change writes a row to `audit_log` saying which super admin did what to which admin.

## Checking each step

`npm test` covers the "Done when" checks in the build guide:

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
| Step 5: set up 2FA with an authenticator app, then sign in; a wrong code is refused; a backup code works once | `tests/integration/adminAuth.test.ts` |
| Step 5: the 5th wrong password locks the account (423), and the right password is refused while locked | `tests/integration/adminAuth.test.ts` |
| Step 5: reusing an old refresh token signs out everywhere; admin routes without a token give 401 | `tests/integration/adminAuth.test.ts` |
| Step 5: authenticator codes match the official RFC 6238 test values; tokens can't be forged or swapped | `tests/unit/totp.test.ts`, `tests/unit/adminTokens.test.ts` |
| Step 5: no password, code or token appears in the logs | `tests/unit/logger.test.ts` |
| Step 6: a staff admin gets 403 on `/admin/users`; a new admin must set up 2FA and change the temporary password | `tests/integration/adminUsers.test.ts` |
| Step 6: a deactivated admin can't sign in, and their open sessions end immediately | `tests/integration/adminUsers.test.ts` |
| Step 6: the last super admin can't be deactivated, even when two super admins try at the same moment | `tests/integration/adminUsers.test.ts` |
| Step 6: each change writes an audit log row | `tests/integration/adminUsers.test.ts` |

To check by hand that the app user cannot drop a table, connect as `lepara_app` and run `DROP TABLE donation;`. It should fail with "must be owner of table donation".

## Deploying (Azure App Service or Render)

- **Runtime:** Node 22, Linux
- **Build command:** `npm ci --include=dev && npm run build && npm prune --omit=dev` (TypeScript is a dev dependency, so it must be installed to build)
- **Start command:** `npm start`
- **Health check path:** `/api/v1/health`
- **Environment variables:** `NODE_ENV=production`, `DATABASE_URL` (the `lepara_app` user), `DATABASE_SSL=true`, `TRUST_PROXY=1`, `CORS_ORIGINS` (the website's address), `LOG_LEVEL=info`, `JWT_ADMIN_SECRET`, `TOTP_ENCRYPTION_KEY`. The host sets `PORT`.
- **Never change `TOTP_ENCRYPTION_KEY` on the live server** once admins have set up 2FA: their authenticator apps would stop working and each would need 2FA reset.

Run `npm run migrate:up` from your own machine, with `MIGRATION_DATABASE_URL` pointing at the cloud database, before deploying code that needs new tables.

## How the code is organised

```
src/
  server.ts              starts the server, shuts down cleanly
  app.ts                 middleware order, routes, error handler
  routes.ts              mounts each module under /api/v1
  config/                environment check, database pool and transactions
  middleware/            validation, error handler, not-found, rate limits, admin sign-in check, roles
  modules/<feature>/     routes → controller → service → repository (Task 1, Section 6.2)
  schemas/common.ts      shared validation rules with user-facing messages
  utils/                 errors, money in cents, dates, paging, reference numbers, safe sorting,
                         authenticator codes (totp.ts), encryption and hashing (crypto.ts), audit log
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
| 005 | `ADMIN_USER`: session version, last authenticator code used; `REFRESH_TOKEN`: revoke reason | Ending all sessions at once, codes that work only once, detecting a copied refresh token |
| 006 | `ADMIN_USER`: one account per email address; two more revoke reasons (2FA reset, password reset) | Admin management |
