# Lepara Ale fele Moya API

The back end for the Lepara Ale fele Moya mobile app and website: Node.js, Express 5, TypeScript and a cloud PostgreSQL database. One API serves both apps; the admin dashboard on the website uses the `/api/v1/admin` routes added in later phases.

Built so far:

- The project skeleton, the app shell with error handling, the database migrations and seeds, the shared building blocks, tests and CI.
- Admin sign-in with an authenticator app (two-factor authentication), sessions, lockout and password change.
- Admin user management: super admins add, edit and deactivate admins, and reset a lost authenticator or a forgotten password.
- Events: the public event list and pages for the app, event types, volunteer tasks, and photo uploads to Azure Blob Storage.
- Announcements for the app's News screen.
- The shop: products, sizes with stock, categories and product photos.
- The four public forms (volunteer, donation pledge, request help, enquiry), with reference numbers and confirmation emails.
- "Track my request": the status of a volunteer application, pledge or request for help, from its reference number and phone digits.
- The admin review queues: accept or decline volunteers, requests for help and pledges (with a decision email), record attendance, close requests, mark enquiries reviewed.
- Donations and stock: recording and voiding donations, stock items and adjustments, receiving pledges, and fulfilling requests from stock.
- Customer accounts for the shop: sign-up with an emailed code, sign-in (with optional emailed login codes), sessions, profile, password change and reset, and account deletion.
- The cart and orders: a checkout quote, placing an order (EFT or cash on delivery) without overselling, the customer's Orders tab and cancelling.
- Orders for admins: recording payments, packing, shipping, delivery and cancelling, with an email at each step.
- Push notifications through Firebase Cloud Messaging: news to every phone, order updates to the customer's phones.
- The shop takes EFT and cash on delivery.
- The admin dashboard numbers and five reports, as JSON or a CSV download.
- Hardening: tuned rate limits, security tests, the API documentation (Swagger UI and a Postman collection), test coverage in CI, and the final deployment.

Step 18 (PayFast card payments) was left out by decision: the shop takes EFT and cash on delivery.

## Live API and documentation

| What | Where |
| --- | --- |
| Live API | `https://lepara-api.onrender.com/api/v1` (health check: `/api/v1/health`) |
| API documentation | `https://lepara-api.onrender.com/api/docs`: every endpoint with an example request and reply, and **Try it out** |
| OpenAPI file | [`docs/openapi.yaml`](docs/openapi.yaml), also served at `/api/openapi.yaml` and `/api/openapi.json` |
| Postman collection | [`docs/lepara-api.postman_collection.json`](docs/lepara-api.postman_collection.json): import it in Postman (**Import**, then choose the file) |
| Test accounts | In the private submission, not in this public repository. See [Test accounts](#test-accounts) for how to sign in |

The live API runs on Render's free plan, so after 15 minutes without requests it goes to sleep: the first request then takes up to a minute. Open `/api/v1/health` first and wait for `"status": "ok"`.

Running the API on your own computer takes about 15 minutes: follow [First-time setup](#first-time-setup) below. The documentation is then at http://localhost:3000/api/docs.

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
- `JWT_ADMIN_SECRET`, `JWT_CUSTOMER_SECRET` and `TOTP_ENCRYPTION_KEY`: make each one with the command shown above it in `.env.example`, and paste the output. Use different values on your machine and on the live server.

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

Open http://localhost:3000/api/v1/health. You should see `"status": "ok"` and `"database": "up"`. The API documentation is at http://localhost:3000/api/docs.

**6. Run the tests**

```bash
npm test                    # needs TEST_DATABASE_URL (step 2); the test database is emptied each run
npm run test:coverage       # the same, plus a coverage report in coverage/index.html
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API and restarts it when you save a file |
| `npm run build` / `npm start` | Compiles to `dist/` / runs the compiled API |
| `npm test` | Runs all tests (database tests need `TEST_DATABASE_URL`) |
| `npm run test:coverage` | Runs all tests and reports which lines of `src/` they run (`coverage/index.html`) |
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

## Events (initiatives)

**For the app and website (no sign-in):**

| Request | What it gives |
| --- | --- |
| `GET /initiatives?phase=upcoming\|completed\|all&typeId=&page=&pageSize=` | Event cards: Upcoming first (soonest first), then Completed (latest first) |
| `GET /initiatives/:id` | One event page, with its volunteer `tasks` |
| `GET /initiatives/:id/tasks` | The task picker on the volunteer form |
| `GET /initiative-types` | Event types, for filters |

Each event has `initiativeId`, `title`, `typeId`, `typeName`, `summary` (the short text on a card), `description` (the full text), `location`, `startDate`, `endDate`, `startTime`, `endTime`, `imageUrl`, `donationNeeds`, `volunteersRequired`, and three ready-made fields for the screen:

- `dateLabel`: `"24 Oct 2026"`, `"24–25 Oct 2026"` or `"30 Oct – 2 Nov 2026"`
- `timeLabel`: `"10:00–14:00 SAST"`, `"From 10:00 SAST"`, or `null`
- `phase`: `"Upcoming"` or `"Completed"`. An event stays Upcoming until its last day has passed in Johannesburg.

Drafts are never public: they don't appear in the list, and their pages answer 404.

**For the admin dashboard (any signed-in admin):**

| Request | What it does |
| --- | --- |
| `GET /admin/initiatives?status=Draft\|Published\|Closed\|all&search=&typeId=` | All events, newest first, with `status`, `taskCount` and `applicationCount` |
| `GET /admin/initiatives/:id` | One event, with its tasks and how many applications each has |
| `POST /admin/initiatives` | A new event. It always starts as a draft |
| `PATCH /admin/initiatives/:id` | Change details; send `null` to clear an optional field |
| `PATCH /admin/initiatives/:id/status` `{ status }` | `Draft` → `Published` → `Closed`, and nothing else |
| `POST /admin/initiatives/:id/image` | Upload the event photo (see below) |
| `GET`, `POST /admin/initiatives/:id/tasks`; `PATCH`, `DELETE /admin/initiatives/:id/tasks/:taskId` | Volunteer tasks |
| `GET`, `POST /admin/initiative-types`; `PATCH /admin/initiative-types/:id` | Event types |

Rules:

- **Publishing** needs a summary, a location, a start date of today or later, and at least one task if volunteers are needed. If something is missing, the reply lists each missing field.
- **Status** only moves forward. Going back gets a `409` with a plain explanation.
- **A closed event** is a record of what happened, so it and its tasks can't be changed. Write any recap in the description before closing it.
- **A task** that already has volunteer applications can't be deleted, but it can be renamed. Task names are unique within an event, and type names are unique, ignoring capitals.
- **Photos:** send the file as form data in a field called `image`:
  ```js
  const form = new FormData();
  form.append('image', file);
  await fetch(`${API}/admin/initiatives/${id}/image`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${accessToken}` } });
  ```
  JPEG, PNG or WebP only, checked from the file's contents, not its name. The limit is 2 MB. A wrong type gets `415`, a file that's too big gets `413`, and if storage isn't set up the reply is `503`. A new photo replaces the old one, which is deleted.

### Setting up photo storage (Azure)

1. In the Azure portal, **create a storage account**. Use the Standard performance tier and LRS redundancy. On the **Advanced** tab, tick **Allow enabling anonymous access on individual containers**.
2. In the account, open **Data storage → Containers**, add a container called `images`, and set its **Anonymous access level** to **Blob**. Anyone can then view a photo by its address, but nobody can list the container or change anything in it.
3. Open **Security + networking → Access keys** and copy **Connection string** (key1).
4. Put it in `.env` as `AZURE_STORAGE_CONNECTION_STRING="..."` (with the quotes), and in Render's environment variables (without quotes). The connection string is a password: never commit it or share it.

## News (announcements)

| Request | What it does |
| --- | --- |
| `GET /announcements?page=&pageSize=` | The News screen: shown announcements only, newest first (no sign-in) |
| `GET /admin/announcements?status=active\|inactive\|all&search=` | All announcements, newest first |
| `GET /admin/announcements/:id` | One announcement |
| `POST /admin/announcements` `{ title, body }` | Publishes straight away (Task 1 has no drafts for announcements) |
| `PATCH /admin/announcements/:id` `{ title?, body? }` | Corrects it; the publishing date stays the same |
| `PATCH /admin/announcements/:id/active` `{ isActive }` | Hides it from the app (`false`) or shows it again (`true`) |

Each announcement has `announcementId`, `title`, `body`, `publishedAt` and `dateLabel`, the publishing date in Johannesburg written like `"16 Oct 2026"`. The admin replies also have `isActive` and `publishedBy`. Titles are 5 to 120 characters and the text is 10 to 2,000. Publishing a new announcement also sends it as a push notification to every registered phone (see "Push notifications" below).

## Shop (products)

**For the app and website (no sign-in):**

| Request | What it gives |
| --- | --- |
| `GET /products?search=&categoryId=&page=&pageSize=` | Product cards, by category then name. `search` looks in the name, colour, material and category |
| `GET /products/:id` | One product page, with each size's availability |
| `GET /product-categories` | Categories for the filter chips, with `productCount` (shown products only) |

A product card has `productId`, `name`, `categoryId`, `categoryName`, `colour`, `material`, `priceCents`, `price` (the label, e.g. `"R250"`), `subtitle` (e.g. `"White / Cotton / XS–XXL"`), `imageUrl`, `sizes` (smallest first) and `inStock`. The product page adds `description` and `variants`: `[{ variantId, size, availability }]`, where availability is `"In stock"`, `"Low stock"` (3 or fewer) or `"Sold out"`. The exact number left is never shown in the app. Keep `variantId`: the cart and orders (step 15) use it.

**For the admin dashboard (any signed-in admin):**

| Request | What it does |
| --- | --- |
| `GET /admin/products?status=active\|inactive\|all&search=&categoryId=` | All products, with SKU codes, exact stock per size and `totalStock` |
| `GET /admin/products/:id` | One product |
| `POST /admin/products` | `{ categoryId, name, colour?, material?, description?, price, isActive?, variants?: [{ size, sku, quantityOnHand }] }`. `price` is in rands (`250` or `"250.50"`) |
| `PATCH /admin/products/:id` | Change details or price; `isActive: false` hides it, `true` shows it |
| `POST /admin/products/:id/image` | The product photo, the same way as event photos |
| `POST /admin/products/:id/variants` | Add a size: `{ size, sku, quantityOnHand }` |
| `PATCH /admin/products/:id/variants/:variantId` | Change a size's SKU code or stock count |
| `GET`, `POST /admin/product-categories`; `PATCH /admin/product-categories/:id` | Categories: `{ name, sortOrder }` (lower numbers show first) |

Rules:

- **Products are hidden, never deleted**, because orders refer to them. A new product starts hidden, and can only be shown once it has at least one size.
- **Sizes** are `XS`, `S`, `M`, `L`, `XL`, `XXL` or `One size`, each once per product. A size can't be renamed; add the right one instead.
- **SKU codes** are unique across the shop, ignoring capitals (they are stored in capitals).
- **Prices** must be more than R0. Every price and stock change is recorded in the audit log with the old and new value.
- **Search** is safe to use with any text: a search for `'; DROP TABLE product; --` simply finds nothing.

## Public forms (volunteer, give, request help, enquiry)

No sign-in. Each form replies `201` with:

```json
{ "success": true, "data": { "referenceNumber": "VOL-7K3P9X", "status": "Submitted", "submittedAt": "2026-10-16T08:30:00.000Z", "message": "Thank you. ..." } }
```

Show `referenceNumber` big and clear: people use it later, with the last 4 digits of their phone number, to check progress. `message` is a ready-made thank-you line. If an email address was given, the same reference number is emailed.

| Request | Body | Reference |
| --- | --- | --- |
| `POST /volunteer-applications` | `{ initiativeId, taskId, fullName, phone, email?, contribution, availability, consent }` | `VOL-…` |
| `POST /donation-pledges` | `{ fullName, email, phone, initiativeId?, category, description, estimatedValue?, consent }` | `PLG-…` |
| `POST /assistance-requests` | `{ fullName, phone, email?, requestType, description, consent }` | `REQ-…` |
| `POST /enquiries` | `{ fullName, email, phone?, enquiryType, message, consent }` | none (`null`) |
| `GET /form-options` | | The choices for `category`, `requestType` and `enquiryType`, each as `{ value, label }` |

- **`consent`** must be `true` (the ticked POPIA box). Anything else gets `400` on the `consent` field.
- **Phone numbers:** South African, written any common way (`071 234 5678`, `+27 71 234 5678`). They are stored as `+27712345678`.
- **Optional fields** can be left out, or sent as `""` or `null`.
- **`description`, `contribution` and `message`:** 10 to 1,000 characters. **`availability`:** 3 to 200 characters, e.g. `"24 Oct, 10:00–14:00"`.
- **Volunteers:** the event must be published, not over (Johannesburg date), and looking for volunteers. `taskId` must be one of that event's tasks (from `GET /initiatives/:id/tasks`). One phone number can have only one application waiting for review per event; a second one gets `409` on the `phone` field.
- **Pledges:** `category` is `Goods`, `Monetary`, `School supplies` or `Food and essentials`. `estimatedValue` is in rands, from 0 to 1,000,000: send a number (`1200` or `"1200.50"`), not text such as `"R1,200 (estimated)"`. Leave out `initiativeId` for a general donation; if given, the event must be open. No payment is taken.
- **Request help:** `requestType` is `Clothing`, `Blankets`, `Sanitary products`, `Food`, `School supplies` or `Other`. To change the list, edit `src/modules/submissions/submissions.options.ts`; no database change is needed.
- **Enquiries:** `enquiryType` is `Donor` or `Partner`. Task 1's `ENQUIRY` table has no reference number, so the reply's `referenceNumber` is `null`.
- **A draft, closed or finished event** gets `400` on the `initiativeId` field with a plain message, so the app can show it under the event picker.
- **Spam protection:** each IP address can send 5 forms per 10 minutes (then `429`). The website should also add a hidden spam-trap field called `website`; people never see it, but simple bots fill it in, and the API then replies with a pretend success and saves nothing:
  ```html
  <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true"
         style="position:absolute;left:-9999px" />
  ```
  Don't use `display:none` (some bots skip those), and don't let the browser autofill it. The mobile app doesn't need the field.

### Setting up email

Emails go out **after** the reply, so a slow or broken mail service never delays or fails a form. A failed email is tried 3 times, then logged. The API picks the first of these that is set up:

1. **`BREVO_API_KEY`: Brevo's web API.** Use this for the live API. **Render's free plan blocks the usual email (SMTP) ports** since September 2025, so SMTP can't work there, but Brevo's API uses HTTPS like any web request.
2. **`SMTP_HOST`: any SMTP service.** Fine on your own machine or on paid hosting.
3. **Neither, on your own machine (`npm run dev`):** emails go to a free test inbox at [ethereal.email](https://ethereal.email). Nobody receives them; the terminal shows a `preview` link to read each one.
4. **Neither, on the live server:** forms still work; the log notes that no email was sent.

**Brevo (free, 300 emails a day):**

1. Sign up at brevo.com.
2. Add the sender address: **Settings (the gear icon) → Senders, domains, IPs → Senders → Add a sender**, then click the link Brevo emails to it (any inbox you can open will do). Put it in `MAIL_FROM` as `Lepara Ale fele Moya <that address>`.
3. Make an API key: **Settings → SMTP & API → API Keys → Generate a new API key**. Choose **Restricted** access and set **Transactional email** to **All** (sending needs it); leave everything else on **None**. The key starts with `xkeysib-` and is shown only once. Put it in `BREVO_API_KEY`. Brevo switches a key off after 90 days without use, so make a new one if emails stop after a quiet spell.
4. Render's outgoing address can change, so check **Settings → Security → Authorized IPs**: if blocking is **Activated** for API keys, choose **Deactivate for API**. Otherwise Brevo answers `401 ... unrecognised IP address` and the log shows "Email was refused".

**Gmail, for testing on your own machine:** turn on 2-Step Verification for the Google account, create an **app password** at myaccount.google.com/apppasswords, then set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` (the Gmail address), `SMTP_PASS` (the 16-letter app password, without spaces) and `MAIL_FROM` (the same Gmail address).

The API key and the app password are passwords: never commit them or share them.

## Track my request

`POST /track` `{ referenceNumber, phoneLast4 }` (no sign-in). The reference number can be typed in any case, with or without the dash or spaces (`req 7k3p9x` works). `phoneLast4` is the last 4 digits of the phone number given on the form.

A match replies `200` with:

```json
{ "success": true, "data": { "referenceNumber": "REQ-7K3P9X", "type": "assistance_request", "typeLabel": "Request for help", "status": "Under review", "statusMessage": "Our team is reviewing your request.", "isFinal": false, "submittedAt": "2026-10-16T08:30:00.000Z", "lastUpdatedAt": "2026-10-17T10:05:00.000Z" } }
```

- `type` is `volunteer_application` (VOL), `assistance_request` (REQ) or `donation_pledge` (PLG). `statusMessage` is a ready-made sentence for the screen. `isFinal` is `true` once nothing more will happen (for example Declined or Received).
- `lastUpdatedAt` is when an admin last made a decision, or `submittedAt` if nobody has yet.
- **No personal details** are ever in the reply: no name, phone number, email, description or event.
- **A wrong reference number and wrong digits get the same reply:** `404` "We couldn't find a match. Please check your reference number and phone number." So nobody can find out whether a reference number exists by guessing. The digits are compared in constant time.
- A reference number in the wrong shape (not like `REQ-7K3P9X`) gets `400` on the `referenceNumber` field.
- **5 wrong attempts per IP address per 15 minutes**, then `429`. Correct attempts don't count.
- Enquiries have no reference number, so they can't be tracked.

## Review queues (admin)

Staff and super admins. Every list takes `page`, `pageSize`, `search`, `from` and `to` (days as `YYYY-MM-DD`, in Johannesburg time), `status` (one of the statuses below, or `all`, the default) and `sort`. A filter or sort it doesn't understand is ignored, so the full list shows instead of an error. Replies hold contact details, so they are never cached.

| Request | Filters | `sort` (default `newest`) |
| --- | --- | --- |
| `GET /admin/volunteer-applications` | `initiativeId`, `taskId` | `newest`, `oldest`, `name`, `status`, `event` |
| `GET /admin/volunteer-applications/:id` | | |
| `GET /admin/assistance-requests` | `requestType` | `newest`, `oldest`, `name`, `status`, `type` |
| `GET /admin/assistance-requests/:id` | | |
| `GET /admin/donation-pledges` | `category`, `initiativeId` | `newest`, `oldest`, `name`, `status`, `value` |
| `GET /admin/enquiries` | `enquiryType` | `newest`, `oldest`, `name`, `status` |

`search` looks in the name, email, reference number and phone number (`071 234 5678` finds `+27712345678`); for enquiries also the message.

Each item has the person's details, `status`, `submittedAt`, `reviewedAt`, `reviewedBy` (`{ adminId, fullName }`) and `decisionReason`. Volunteer applications also have `initiative` and `task: { taskId, name, volunteersNeeded, accepted }`, so the dashboard can show "3 of 6 accepted" for each task. Pledges have `estimatedValue` (`"R1 200.00"`) and `estimatedValueCents`.

**Decisions** follow the Task 1 state machines. Nothing moves backwards, and a final decision can't be changed (`409` with a plain explanation):

| Request | Body `status` | Moves allowed |
| --- | --- | --- |
| `PATCH /admin/volunteer-applications/:id/decision` | `Accepted`, `Declined`, `Attended`, `Did not attend` | Submitted → Accepted or Declined; Accepted → Attended or Did not attend (from the event's first day) |
| `PATCH /admin/assistance-requests/:id/decision` | `Approved`, `Declined`, `Closed` | Submitted or Under review → Approved or Declined; Fulfilled → Closed |
| `PATCH /admin/donation-pledges/:id/status` | `Accepted`, `Declined` | Pending → Accepted or Declined |
| `PATCH /admin/enquiries/:id/status` | `New`, `Reviewed` | Either way (no email) |

- **Declining needs a `reason`** (3 to 500 characters), or the reply is `400` on the `reason` field. The person sees the reason in their email; tracking never shows it.
- **Opening a request** (`GET /admin/assistance-requests/:id`) moves it from Submitted to Under review, as in Task 1 use case UC-03, and records who opened it.
- **Fulfilled** (requests) and **Received** (pledges) are recorded together with the stock and donation records in step 13.
- Every decision saves who made it and when, writes an `audit_log` row, and shows up in tracking at once. Accepting, approving and declining also email the person, if they gave an email address.
- If two admins decide on the same submission at the same moment, one decision is saved and the other gets `409`.

## Donations and stock (admin)

Staff and super admins. Every change here runs in one transaction that locks the stock rows it changes, so two admins can never give out the same last blanket twice, and a failure halfway saves nothing. Stock only ever changes through a movement (a donation, a fulfilled request or an adjustment), so each item's movements always add up to its quantity on hand.

| Request | What it does |
| --- | --- |
| `GET /admin/stock-items?search=&category=&low=true&sort=name\|quantity\|category` | Stock items. `low=true` shows only items at or below their low-stock level (`isLow`) |
| `GET /admin/stock-items/:id` | One item |
| `POST /admin/stock-items` `{ name, category?, unit, reorderLevel?, openingQuantity? }` | A new item. `unit` is singular (`blanket`). The opening stock is recorded as a movement |
| `PATCH /admin/stock-items/:id` `{ name?, category?, unit?, reorderLevel? }` | Changes details. The quantity can't be set here |
| `GET /admin/stock-items/:id/movements?page=&pageSize=` | The item's history, newest first. Each movement's `source` is a donation, a request or an adjustment |
| `POST /admin/stock-movements` `{ stockItemId, type, quantity, reason }` | An adjustment by hand (`Increase` or `Decrease`): damaged goods, a recount. Never below zero |
| `GET /admin/donations?type=&status=active\|voided\|all&initiativeId=&stockItemId=&from=&to=&search=&sort=newest\|oldest\|donor\|amount` | Recorded donations. `search` looks in the donor's name and the receipt reference |
| `GET /admin/donations/:id` | One donation |
| `POST /admin/donations` | Records a donation (below) |
| `POST /admin/donations/:id/void` `{ reason }` | Voids a mistake: keeps the record and takes its goods back out of stock |
| `POST /admin/donation-pledges/:id/receive` | An accepted pledge has arrived: records the donation and marks the pledge Received |
| `POST /admin/assistance-requests/:id/fulfil` `{ items: [{ stockItemId, quantity }] }` | An approved request was helped: takes the items out of stock and marks it Fulfilled |

**Recording a donation:** `{ type, donorName, isAnonymous?, initiativeId?, dateReceived?, ... }` plus, by type (Task 1, Section 8.4):

- `Monetary`: `amount` in rands (`250` or `"250.50"`) and an optional `receiptReference`. A quantity or stock item gets `400`.
- `Goods`: `stockItemId` and `quantity`. An amount gets `400`. Stock goes up by exactly the quantity.

`dateReceived` defaults to today and can't be in the future. With `isAnonymous: true` the name may be left out (it is saved as "Anonymous").

**Receiving a pledge** takes the same `amount`/`receiptReference` or `stockItemId`/`quantity`. The donor and event come from the pledge, and the type follows its category (`type` can override it). The pledge must be Accepted (`409` otherwise), the donor gets a thank-you email, and tracking shows Received.

**Fulfilling a request:** the request must be Approved. Send `{ "items": [] }` when the help wasn't goods. If any item is short, nothing is taken and the reply is `409` naming the item and how many are left. Afterwards the request can be closed with `PATCH /admin/assistance-requests/:id/decision` `{ "status": "Closed" }`.

**Voiding** needs a reason. If some of the donated goods have already been given out, taking them back would push stock below zero, so the reply is `409` saying so. Fix the stock with an adjustment instead. Voiding a donation that came from a pledge leaves the pledge Received.

## Customer accounts (the app's Account tab)

For shop customers. Admins sign in separately (above); a customer token never works on `/admin` routes, and an admin token never works here.

| Request | Body | Reply (`data`) |
| --- | --- | --- |
| `POST /auth/register` | `{ firstName, lastName, email, mobile, password, confirmPassword, acceptTerms: true }` | `201 { email, message }`. A 6-digit code is emailed |
| `POST /auth/verify-email` | `{ email, code }` | A session (below): the customer is signed in |
| `POST /auth/resend-code` | `{ email }` for a new sign-up code, or `{ pendingToken }` for a new login code | `{ message }`, or `429` within 60 seconds of the last code |
| `POST /auth/login` | `{ email, password }` | A session, or `{ twoFactorRequired: true, pendingToken, expiresIn }` when login codes are on |
| `POST /auth/login/verify` | `{ pendingToken, code }` | A session |
| `POST /auth/refresh` | `{ refreshToken }` (app) or nothing (website, uses the cookie) | A new session; the old refresh token stops working |
| `POST /auth/logout` | `{ refreshToken }` (app) or nothing (website) | `{ signedOut: true }` |
| `POST /auth/forgot-password` | `{ email }` | `{ message }`, the same whether or not the email has an account |
| `POST /auth/reset-password` | `{ email, code, newPassword, confirmPassword }` | `{ passwordReset: true }`. Every device is signed out; sign in with the new password |
| `GET /me` | | The profile |
| `PATCH /me` | `{ firstName?, lastName?, mobile?, email? }` | The profile. A new `email` shows as `pendingEmail` until its code is entered |
| `POST /me/email/verify` | `{ code }` (sent to the new address) | The profile, with the new email |
| `PATCH /me/password` | `{ currentPassword, newPassword, confirmPassword }` | A new session. Other devices are signed out |
| `PATCH /me/two-factor` | `{ enabled, password }` | The profile. When on, each sign-in also needs a code from email |
| `DELETE /me` | `{ password }` | `{ deleted: true }`. Personal details are removed and every device signed out; past orders are kept for the records |

A **session** is `{ accessToken, tokenType: "Bearer", expiresIn: 900, customer }`, plus `refreshToken` and `refreshExpiresAt` for the app. The **profile** (`customer`) has `customerId`, `firstName`, `lastName`, `email`, `mobile`, `twoFactorEnabled`, `pendingEmail`, `lastLoginAt` and `createdAt`.

How the app and the website should use it:

- **Send the access token** as `Authorization: Bearer <accessToken>` on `/me` and the order requests below. It lasts 15 minutes; on `TOKEN_EXPIRED`, refresh and try again.
- **The mobile app** gets the refresh token in the reply. Keep it in secure storage (`expo-secure-store`), never in AsyncStorage, and send it to `/auth/refresh` and `/auth/logout` as `{ "refreshToken": "..." }`. It lasts 7 days and is replaced on every refresh, so always save the new one.
- **The website** never sees the refresh token: it's in an httpOnly cookie. Call `/auth/*` with `fetch(url, { credentials: 'include' })`. (The API tells them apart by the `Origin` header, which browsers always send and the app doesn't.)
- **Error codes:** `EMAIL_NOT_VERIFIED` (403, right password but the email isn't confirmed: show the code screen and offer "resend"), `ACCOUNT_LOCKED` (423), `RATE_LIMITED` (429), `VALIDATION_ERROR` (show `fields`; wrong codes are on the `code` field).

Security rules built in:

- **Codes** are 6 random digits, stored only as a keyed hash, valid for 10 minutes, with 5 tries each. A new code cancels the older ones. At most one code a minute and 5 an hour per email address.
- **Nobody can find out who has an account:** registering an email that already has one gets the same reply (the email itself tells the owner to sign in), and so do "resend" and "forgot password". Sign-in only says the email isn't confirmed after the right password.
- **Five wrong passwords or login codes** in a row lock the account for 15 minutes.
- **Refresh tokens** are stored only as hashes and replaced on every use. If an old one comes back, someone copied it, so every session that customer has is ended.
- **Changing or resetting the password** signs out every other device straight away (their access tokens stop working too), and the customer gets an email about it.
- **A new email address** only replaces the old one after the code sent to it is entered.

## Cart and orders (the app's checkout and Orders tab)

The bag stays on the phone. The API prices it and places it; it never trusts a price or total from the app.

| Request | Sign-in | Body | Reply (`data`) |
| --- | --- | --- | --- |
| `POST /cart/quote` | No | `{ items: [{ variantId, quantity }] }` | The checkout summary (below) |
| `POST /orders` | Customer, plus an `Idempotency-Key` header | `{ items, recipientName, streetAddress, city, postalCode, phone, paymentMethod, acceptTerms: true }` | `201` and the order |
| `GET /me/orders?page=&pageSize=` | Customer | | The customer's orders, newest first |
| `GET /me/orders/:orderNumber` | Customer | | One order, e.g. `/me/orders/LAFM-1008` |
| `POST /me/orders/:orderNumber/cancel` | Customer | `{ reason? }` | The order, now Cancelled |

- **Lines** are `{ variantId, quantity }`: the `variantId` of the size picked on the product page, 1 to 10 of each, 1 to 20 lines, each size once.
- **The checkout summary** has `lines` (each with `name`, `size`, `unitPrice`, `lineTotal`, `availability` and a `problem` to show under it, or `null`), `itemCount`, `subtotal`, `deliveryFee`, `total` (each also in cents, e.g. `totalCents`), `canPlaceOrder` and `paymentMethods` (the two choices, with a label and a note for the screen). A problem never makes the quote fail: it says what to fix, e.g. `"Community hoodie (size M): only 1 left. Please lower the quantity."`
- **Placing an order** checks everything again inside one database transaction. If a line can't be ordered, the reply is `409` naming the item and how many are left (`fields` has one entry per line: `items.0`, `items.1`, ...), and nothing is saved.
- **`paymentMethod`** is `"EFT"` or `"Cash on delivery"`. Remove the card fields from the app. An EFT order starts as Pending payment, and its `paymentInstructions` give the reference (the order number), the amount and the bank details. A cash-on-delivery order starts as Confirmed.
- **The order** has `orderNumber`, `status` and `statusLabel` (the app's words), `statusMessage` (what happens next), `paymentMethod`, `paymentStatus`, `canCancel`, `placedAt`, `items`, the totals, `deliveryAddress`, `courierReference`, `paymentInstructions`, `tracking` (the four steps on the tracking card: Order confirmed, Packed with care, On the way, Delivered, each with `done` and its time `at`) and `history`.
- **Cancelling** works while the order is Pending payment or Confirmed and unpaid. The stock goes back and the customer gets an email. A paid order needs the NGO to arrange the refund, so the reply is `409` asking the customer to contact the NGO.

**The `Idempotency-Key` header** stops a double tap from creating two orders. When the customer taps "Place order", the app makes a new UUID (`Crypto.randomUUID()` from `expo-crypto`) and sends it with that request. If the request has to be sent again (no reply, a dropped connection), send it with **the same key**: the API replies with the first order (and the header `Idempotent-Replayed: true`) instead of placing a second one. After a success, clear the bag and make a new key for the next order. Keys last 24 hours. The same key with a different bag gets `422 IDEMPOTENCY_KEY_REUSED`.

Rules built in:

- **Prices come from the database only.** A price, name or total in the request is ignored. The quote and the order use the same pricing code, so the totals always match: line total = unit price × quantity, subtotal = the lines, total = subtotal + delivery (`DELIVERY_FEE_CENTS`, R60). The database also refuses an order whose total isn't the subtotal plus delivery.
- **Stock can't be oversold:** placing an order locks the sizes it takes, so two orders for the last item at the same moment give one success and one `409`.
- **One customer can't see another's orders:** they get `404`, as if the order didn't exist.
- **At most 3 unpaid orders open at once** per customer (waiting for payment or delivery), so nobody can tie up all the stock with orders they never pay for.

## Orders (admin)

For the dashboard; any signed-in admin.

| Request | Body | What it does |
| --- | --- | --- |
| `GET /admin/orders?status=&paymentStatus=&paymentMethod=&from=&to=&search=&sort=&page=&pageSize=` | | Orders, newest first. `status=Confirmed` is the list to pack. `search` looks in the order number, customer name and email, recipient and phone numbers. `from`/`to` are dates (`YYYY-MM-DD`, Johannesburg). `sort` is `newest`, `oldest` or `updated` |
| `GET /admin/orders/:id` | | One order with its items, delivery address, customer contact details, status history (with the admin who made each change), payments and `actions` |
| `PATCH /admin/orders/:id/status` | `{ status, courierReference?, reason?, refunded? }` | Moves the order on, or cancels it |
| `PATCH /admin/orders/:id/payment` | `{ amount, reference? }` | Records an EFT payment that arrived, or the cash collected for a cash-on-delivery order |

**`actions`** tells the dashboard which buttons to show: `nextStatus` (the one step the order can move to, or `null`), `canCancel`, `cancelNeedsRefund` and `canRecordPayment`.

How an order moves:

- **Forward only, one step at a time:** Confirmed → Packed → Shipped → Delivered. Skipping a step or going back gets `409` with the reason, for example "Orders move one step at a time: this order is Confirmed, so the next step is Packed."
- **Shipped needs a `courierReference`** (the courier's tracking number), otherwise `400`. The customer sees it in the app and the email.
- **An EFT order** stays Pending payment until its payment is recorded. `amount` is in rands (`310` or `"310.00"`) and must equal the order total, otherwise `400` on `amount`. `reference` is the reference on the bank statement; left empty, it is the order number. Recording the payment confirms the order.
- **Cash on delivery** can be packed straight away. Record the cash once it is collected (usually after delivery). This doesn't change the status.
- **Cancelling** (`status: "Cancelled"`) needs a `reason`, which the customer receives in the email and sees in the app. It's allowed until the order is shipped, and the stock goes back. A paid order is only cancelled with `refunded: true`, once the money has been paid back to the customer.
- **Every change** adds a status history row (when the status changes), an audit log row, an email to the customer and a push notification to the phones where the customer is signed in. Two admins changing the same order at the same moment: the first wins, the second gets `409`.

## Push notifications

The app registers its phone, and the API sends through Firebase Cloud Messaging (FCM):

| Request | Sign-in | Body | Reply (`data`) |
| --- | --- | --- | --- |
| `POST /devices` | Optional (customer) | `{ token, platform }` | `{ registered: true, linkedToAccount }` |
| `DELETE /devices/:token` | No | | `{ removed }` (notifications switched off on this phone) |

What gets sent:

- **A new announcement** goes to every registered phone: the title "News: …" and the first 150 characters of the text, with `data: { type: "announcement", announcementId }` so the app can open it.
- **An order update** from the dashboard (payment received, packed, on the way, delivered, cancelled) goes to the phones where that customer is signed in, with `data: { type: "order", orderNumber, status }`.
- **Tokens FCM rejects** (the app was uninstalled) are deleted after each send, and phones not seen for 270 days are dropped.
- **Sending happens after the reply**, in the background: a slow or unreachable Firebase never delays or undoes the admin's change; the failure is logged.

For the mobile team:

- **The token** is the native one from `expo-notifications`: `(await Notifications.getDevicePushTokenAsync()).data`, not `getExpoPushTokenAsync()` (Expo push tokens only work with Expo's own service; the API refuses them with a clear message). `platform` is `"android"` or `"ios"`.
- **Register on every app start**, after asking for permission, and again after signing in or out. Signed in (send `Authorization: Bearer <accessToken>`), the phone is linked to the customer for order updates; without a sign-in the link is removed, so a signed-out phone gets news only. Call `DELETE /devices/<token>` when the user switches notifications off.
- **Expo Go can't receive FCM messages:** use a development build (`npx expo run:android` or EAS) with `google-services.json` from the Firebase project, and set `android.package` in `app.json` to the package name registered in Firebase.
- **iPhones** need an Apple developer account and an FCM token (from `@react-native-firebase/messaging`) instead of the native APNs token, so for this project push notifications are tested on Android.

### Setting up Firebase

Push notifications stay off (and everything else works) until this is done. One Firebase project is shared by the app and the API.

1. At [console.firebase.google.com](https://console.firebase.google.com), choose **Create a project** (Google Analytics isn't needed).
2. **Add an Android app** with the package name the mobile team sets in `app.json` (`android.package`, for example `com.leparaalefelemoya.app`). Give the downloaded `google-services.json` to the mobile team.
3. **Project settings → Service accounts → Generate new private key.** This downloads a JSON key file. It is a password for the project: never commit it, never paste it in a chat, and don't leave it in the project folder.
4. Turn it into one line of base64 in PowerShell, which copies it straight to the clipboard:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\<key file>.json")) | Set-Clipboard
   ```
5. On Render, add `FIREBASE_SERVICE_ACCOUNT` and paste. After the redeploy, the first notification logs "Push notifications are sent through Firebase". Then delete the key file from Downloads (Firebase can always make a new one, and old keys can be deleted there).

To try it on your own machine, put the same value in `.env` as `FIREBASE_SERVICE_ACCOUNT=...`. Without it, `npm run dev` logs "Push notifications are off".

## Dashboard and reports (admin)

For the dashboard; any signed-in admin. These match the Reporting Component in Task 1 Section 6.3 (donations received over a period, current stock levels, assistance requests by status, volunteer participation per initiative), plus the shop's sales.

| Request | What it gives |
| --- | --- |
| `GET /admin/dashboard` | The numbers for the dashboard's tiles: requests waiting for a decision and approved ones to fulfil, volunteer applications and pledges waiting, new enquiries, low-stock items (with the 5 furthest below their reorder level), orders awaiting payment, to pack, to ship and on the way, upcoming initiatives, and donations this month |
| `GET /admin/reports/donations?from=&to=&type=&initiativeId=` | Donations received: count, donors, money total and average, goods; per initiative; goods per stock item. Voided donations are left out. `type` is `Monetary` or `Goods` |
| `GET /admin/reports/stock?from=&to=` | Every stock item: on hand now, reorder level, low or not, and for the dates: opening, received from donations, removed by voided donations, given out, adjusted, closing (opening + received − voided − given out + adjusted = closing) |
| `GET /admin/reports/assistance-requests?from=&to=` | Requests submitted, by type and status, with the % of decided requests that were approved. Counts only, no personal details |
| `GET /admin/reports/initiatives?from=&to=` | Each published or closed initiative running in the dates: volunteer applications, waiting, accepted, attended, did not attend, declined, attendance %, and donations for it |
| `GET /admin/reports/initiatives/:id` | One initiative, whatever the dates: the same totals, volunteers per task, donated goods per item and pledges by status |
| `GET /admin/reports/sales?from=&to=` | Shop orders placed: counts, items sold, sales (goods and delivery), paid, unpaid and refunded, average order; by status, by payment method and by product and size. Cancelled orders are counted but not added to the sales |

- **Dates** are `YYYY-MM-DD`, whole days in Johannesburg, both included. Without dates a report covers this month so far. `from` after `to` gets `400` on `to`. A range with nothing in it returns zeros, never an error.
- **Amounts** are given as `{ cents, label }`, for example `{ "cents": 125050, "label": "R1 250.50" }`: add up the cents, show the label.
- **Percentages** are numbers from 0 to 100 with one decimal, and 0 when there is nothing to divide by.
- **`?format=csv`** on any report downloads it as a spreadsheet (`Content-Disposition: attachment`). The donations CSV lists each donation, the sales CSV each order, the stock CSV each item, and the others their table. Text that starts with `=`, `+`, `-` or `@` gets a `'` in front so Excel shows it as text instead of running it as a formula. Amounts are plain numbers Excel can add up.
- **Every total is worked out by the database** (`COUNT`, `SUM` and `AVG` in SQL), not added up in code.
- **Not in the reports:** "stock used per initiative" from the plan. Stock leaves through assistance requests, which aren't linked to an initiative in the Task 1 design, so it can't be counted per initiative.

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

## Test accounts

This repository is public, so the usernames and passwords are in the **private submission**, not here. There are two accounts on the live API:

| Account | What it can do |
| --- | --- |
| **Admin** (`super_admin`) | Everything under `/api/v1/admin`: events, news, reviews, stock, donations, products, orders, reports and admin accounts |
| **Customer** | The app's shop: sign in, profile, place and cancel orders. The email is already confirmed and login codes are off |

**Signing in as the admin for the first time** (about 3 minutes; you need a phone with Google Authenticator or Microsoft Authenticator). The account starts with a temporary password, and you set up the authenticator app yourself, so the second step of sign-in is on your own phone. All of this works in the API documentation (`/api/docs`): open each request, click **Try it out**, fill it in and click **Execute**.

1. `POST /admin/auth/login` with the username and temporary password. Copy `pendingToken` from the reply.
2. `POST /admin/auth/2fa/setup` with that `pendingToken`. Copy the whole `qrCodeDataUrl` value (it starts with `data:image/png`), paste it into a new browser tab's address bar, and scan the QR code with the authenticator app. (Or type `manualEntryKey` into the app.)
3. `POST /admin/auth/2fa/confirm` with the `pendingToken` and the 6-digit code from the app. The reply has 10 backup codes: keep one in case.
4. Copy `accessToken` from the reply, click **Authorize** at the top of the page, paste it under **adminBearer** and click **Authorize**.
5. `PATCH /admin/me/password` to choose your own password (the other admin endpoints answer `403 PASSWORD_CHANGE_REQUIRED` until you do). The reply has a new `accessToken`: authorize with that one.

**Later sign-ins:** `POST /admin/auth/login`, then `POST /admin/auth/2fa/verify` with the `pendingToken` and a code from the app. An access token lasts 15 minutes; after that, sign in again (or `POST /admin/auth/refresh`).

**Signing in as the customer:** `POST /auth/login` with the email and password, then authorize with the `accessToken` under **customerBearer**. To make a new customer instead, use `POST /auth/register` with an email address you can read: the 6-digit code arrives by email.

In Postman the steps are the same, and the collection saves each token for the requests that need it (see the collection's description).

## Security

How each item in the security plan is handled, and where it is proved:

| Concern | What the API does | Proof |
| --- | --- | --- |
| SQL injection | Every query uses placeholders (`$1`, `$2`); no SQL is built from user text. Sort orders come from a fixed list (`pickSort`); `%` and `_` in a search are ordinary characters. The live API connects as `lepara_app`, which cannot drop tables or delete records | `tests/integration/security.test.ts` sends `' OR 1=1 --` and others into both sign-ins, tracking and six admin searches: each gets a normal 400, 401 or empty list, and no table changes. By hand: `DROP TABLE donation;` as `lepara_app` fails |
| Password storage | bcrypt, cost 12. Never logged and never in a reply | `tests/unit/logger.test.ts`; the `password_hash` column holds only `$2b$12$...` values |
| Password rules | At least 8 characters with a letter and a number, not on the common-password list, must match the confirm field | `tests/unit/schemas.test.ts` |
| Brute-force sign-in | 5 wrong passwords (or codes) lock the account for 15 minutes; sign-in is limited to 10 tries per address per 15 minutes; the same "email or password is incorrect" message either way | `tests/integration/adminAuth.test.ts` and `customerAuth.test.ts` (the 6th attempt gets 423), `requestHandling.test.ts` (429) |
| Admin 2FA | Required for every admin: authenticator-app codes (TOTP, RFC 6238), each usable once; the secret encrypted with AES-256-GCM; 10 backup codes stored as hashes | `tests/integration/adminAuth.test.ts`, `tests/unit/totp.test.ts`, `tests/unit/crypto.test.ts` |
| Customer 2FA | A 6-digit emailed code to confirm the email, and optionally at every sign-in; stored as a hash, valid 10 minutes, single use, 5 tries | `tests/integration/customerAuth.test.ts`, `tests/unit/customerAuth.test.ts` |
| Tokens | Access tokens are JWTs for 15 minutes. Refresh tokens are random, stored as hashes, 7 days for customers and 12 hours for admins, replaced on every use; an old one used again signs that person out everywhere. Admin and customer tokens use different secrets | `tests/integration/adminAuth.test.ts`, `customerAuth.test.ts` (rotation, reuse, a customer token refused on `/admin`), `tests/unit/adminTokens.test.ts` |
| Token storage | The app keeps the refresh token in expo-secure-store; the website keeps the access token in memory and gets the refresh token as an httpOnly, Secure, SameSite cookie | `tests/integration/customerAuth.test.ts` (cookie, never in the body) |
| Access control | Admin routes need an admin token, and admin accounts need the super admin role. A customer's queries always use the customer ID from the token, so customer B gets 404 for customer A's order | `tests/integration/adminUsers.test.ts` (403 for staff), `orders.test.ts` |
| Data integrity | Foreign keys, CHECK and UNIQUE constraints; multi-table changes in transactions with row locks; totals worked out by the server from database prices; an audit log; nothing is hard-deleted (donations are voided, orders cancelled) | `tests/integration/database.test.ts`, `stock.test.ts`, `orders.test.ts` (two orders for the last item at once) |
| Request hygiene | helmet headers (HSTS, CSP, nosniff), CORS only for the addresses in `CORS_ORIGINS`, a 100 KB body limit, unknown fields removed, text length limits, rate limits | `tests/integration/security.test.ts`, `app.test.ts`, `requestHandling.test.ts` |
| File uploads | JPEG, PNG or WebP only, checked from the file's contents; at most 2 MB; random file names; stored in Azure Blob Storage, not on the API server | `tests/integration/initiatives.test.ts` (a renamed file gets 415, a large one 413) |
| Secrets | `.env` is in `.gitignore`; `.env.example` holds placeholders only; real values are in Render's settings; GitHub secret scanning and push protection are on | The repository holds no keys |
| Transport | HTTPS only (Render), with HSTS; SSL to the database (`DATABASE_SSL=true`) | `tests/integration/security.test.ts` (HSTS header); the padlock in the browser |
| Payments | No card details ever reach the API: EFT payments are checked against the bank statement and recorded by an admin, cash is recorded on delivery | `tests/integration/adminOrders.test.ts` (the amount must equal the order total) |
| POPIA | Consent stored with a time; only the needed fields collected; tracking shows no personal details; emails, phone numbers and tokens hidden in logs; customers can delete their account | `tests/integration/database.test.ts` (consent), `tracking.test.ts`, `tests/unit/logger.test.ts`, `customerAuth.test.ts` (deletion) |
| Failure handling | One error handler gives every failure the same envelope; a failing email or push service never fails a request | `tests/integration/app.test.ts`, `emailFailure.test.ts`, `devices.test.ts` |

**Rate limits** (per IP address; `TRUST_PROXY=1` on Render makes the API see the visitor's real address):

| Limit | Applies to |
| --- | --- |
| 900 requests per 15 minutes | Every request except `/api/v1/health`, as a ceiling against floods. Raised from 300 in Step 20: a school or office shares one address, and one dashboard page makes several requests. Render's health checks never count |
| 10 per 15 minutes | Admin and customer sign-in |
| 10 per 15 minutes | Entering and requesting 6-digit codes |
| 5 per 10 minutes | The public forms |
| 5 wrong attempts per 15 minutes | Tracking (right answers don't count) |

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
| Step 7: drafts never appear in the public list; Upcoming and Completed follow the Johannesburg date | `tests/integration/initiatives.test.ts`, `tests/unit/initiatives.test.ts` |
| Step 7: moving a closed event back to draft gets a friendly error | `tests/integration/initiatives.test.ts` |
| Step 7: a renamed non-image file gets 415; a file over 2 MB gets 413 | `tests/integration/initiatives.test.ts`, `tests/unit/initiatives.test.ts` |
| Step 7: a task with volunteer applications can't be deleted; type names are unique | `tests/integration/initiatives.test.ts` |
| Step 8: hidden announcements never appear publicly; the public list is newest first and paginated | `tests/integration/announcements.test.ts` |
| Step 9: inactive products are hidden from the public; a search for `'; DROP TABLE product; --` returns an empty list | `tests/integration/products.test.ts` |
| Step 9: stock shows as In stock, Low stock or Sold out; sizes and SKU codes are unique | `tests/integration/products.test.ts`, `tests/unit/products.test.ts` |
| Step 10: each form returns a reference number and emails it; a draft or ended event gets a friendly refusal; the 6th form in 10 minutes gets 429; an unticked consent box gets 400 on `consent` | `tests/integration/submissions.test.ts`, `tests/unit/submissions.test.ts` |
| Step 10: a filled-in spam-trap field gets a pretend success and saves nothing | `tests/integration/submissions.test.ts`, `tests/unit/submissions.test.ts` |
| Step 10: an unreachable mail server is retried 3 times, then logged; the form is saved and answered straight away | `tests/unit/email.test.ts`, `tests/integration/emailFailure.test.ts` (and by hand, below) |
| Step 11: the right reference and digits return the status; a wrong reference and wrong digits give identical replies | `tests/integration/tracking.test.ts` |
| Step 11: the reply holds no personal details; the 6th wrong attempt gets 429 | `tests/integration/tracking.test.ts`, `tests/unit/tracking.test.ts` |
| Step 12: declining without a reason gets 400; deciding an already decided submission gets 409 | `tests/integration/reviews.test.ts`, `tests/unit/reviews.test.ts` |
| Step 12: the person gets the decision email and tracking shows the new status; every decision records the admin and an audit row | `tests/integration/reviews.test.ts` |
| Step 13: a goods donation raises stock by exactly its quantity, and a forced error halfway saves nothing; a monetary donation with a quantity is rejected | `tests/integration/stock.test.ts`, `tests/unit/stock.test.ts` |
| Step 13: two fulfilments at once for the last 5 blankets: one succeeds, the other gets 409; voiding after the goods were given out gets 409 | `tests/integration/stock.test.ts` |
| Step 13: each item's movements add up to its quantity on hand | `tests/integration/stock.test.ts` |
| Step 14: register, the code arrives, verify, signed in; registering an existing email gets the same reply as a new one | `tests/integration/customerAuth.test.ts` |
| Step 14: five wrong codes end that code; a resend within 60 seconds gets 429; signing in unverified gets `EMAIL_NOT_VERIFIED` | `tests/integration/customerAuth.test.ts`, `tests/unit/customerAuth.test.ts` |
| Step 14: changing the password signs out other devices; a customer token on an `/admin` route gets 401 | `tests/integration/customerAuth.test.ts`, `tests/unit/customerAuth.test.ts` |
| Step 14: the 5th wrong password locks the account and the 6th attempt gets 423; a copied old refresh token signs out everywhere | `tests/integration/customerAuth.test.ts` |
| Step 15: a price changed in the request has no effect on the total; the quote total equals the order total | `tests/integration/orders.test.ts`, `tests/unit/orders.test.ts` |
| Step 15: two orders at once for the last size M hoodie: one succeeds, the other gets 409 | `tests/integration/orders.test.ts` |
| Step 15: repeating a request with the same Idempotency-Key creates no second order | `tests/integration/orders.test.ts`, `tests/unit/orders.test.ts` |
| Step 15: customer B gets 404 for customer A's order; cancelling restores the stock | `tests/integration/orders.test.ts` |
| Step 16: skipping a status (Confirmed straight to Delivered) gets 409; Shipped without a courier reference gets 400 | `tests/integration/adminOrders.test.ts`, `tests/unit/adminOrders.test.ts` |
| Step 16: the customer's Orders tab shows each step with its time; marking an EFT order paid with the wrong amount gets 400 | `tests/integration/adminOrders.test.ts` |
| Step 16: an admin cancellation needs a reason and puts the stock back; every change writes an audit row | `tests/integration/adminOrders.test.ts` |
| Step 17: publishing an announcement reaches the phones; an order status change reaches only that customer's phones (with a pretend Firebase) | `tests/integration/devices.test.ts` |
| Step 17: an invalid token is removed after a send; with Firebase unreachable, the announcement still publishes | `tests/integration/devices.test.ts`, `tests/unit/push.test.ts` |
| Step 17: sends go 500 phones at a time; a failed batch doesn't stop the rest | `tests/unit/push.test.ts` |
| Step 19: report totals match a hand count; a date range with no data returns zeros, not an error | `tests/integration/reports.test.ts` |
| Step 19: the CSV downloads, and a donor name starting with `=` shows as plain text; an end date before the start date gets 400 | `tests/integration/reports.test.ts`, `tests/unit/reports.test.ts` |
| Step 20: injection strings in sign-in, tracking and admin searches are refused normally and change no data | `tests/integration/security.test.ts` |
| Step 20: HSTS, CSP and the other security headers are sent | `tests/integration/security.test.ts` |
| Step 20: `/api/docs` and the OpenAPI file are served; every route in the code is documented with an example reply | `tests/integration/security.test.ts` |
| Step 20: the documentation page's "Try it out" can sign in (the API's own address is trusted), other websites still can't | `tests/integration/adminAuth.test.ts` |
| Step 20: a mail service that refuses every email doesn't stop a form being saved and answered | `tests/integration/emailFailure.test.ts` |
| Step 20: an uninstalled app's push token is recognised in the error codes of firebase-admin 14 and older versions | `tests/unit/push.test.ts` |
| Step 20: CI runs `npm audit` (no high-severity problems), lint, type checks, all tests with coverage, and the build | `.github/workflows/ci.yml`; the coverage report is under **Actions**, in each run's **Artifacts** |

**Keeping the documentation up to date:** `docs/openapi.yaml` was generated from the API itself: each example reply was produced by running the example request against a test database. When a route is added or changed, update its entry in `docs/openapi.yaml` (and the Postman collection); `security.test.ts` fails if a route in the code has no entry.

To check by hand that a form still saves when email is down, put `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1` and any `MAIL_FROM` in `.env`, run `npm run dev` and send a form. The reply comes at once with a reference number; about 7 seconds later the terminal shows two "trying again" warnings and then "Email could not be sent after 3 tries". Remove those lines afterwards.

To check by hand that the app user cannot drop a table, connect as `lepara_app` and run `DROP TABLE donation;`. It should fail with "must be owner of table donation".

## Deploying (Azure App Service or Render)

- **Runtime:** Node 22, Linux
- **Build command:** `npm ci --include=dev && npm run build && npm prune --omit=dev` (TypeScript is a dev dependency, so it must be installed to build)
- **Start command:** `npm start`
- **Health check path:** `/api/v1/health`
- **Environment variables:** `NODE_ENV=production`, `DATABASE_URL` (the `lepara_app` user), `DATABASE_SSL=true`, `TRUST_PROXY=1`, `CORS_ORIGINS` (the website's address), `LOG_LEVEL=info`, `JWT_ADMIN_SECRET`, `JWT_CUSTOMER_SECRET` (a different value), `TOTP_ENCRYPTION_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, for email `BREVO_API_KEY` and `MAIL_FROM` (on Render's free plan SMTP is blocked, so use Brevo's API there), for the shop the four `EFT_` bank settings (`DELIVERY_FEE_CENTS` only if it isn't R60), and `FIREBASE_SERVICE_ACCOUNT` for push notifications. The host sets `PORT`.
- **Never change `TOTP_ENCRYPTION_KEY` on the live server** once admins have set up 2FA: their authenticator apps would stop working and each would need 2FA reset.

Run `npm run migrate:up` from your own machine, with `MIGRATION_DATABASE_URL` pointing at the cloud database, before deploying code that needs new tables.

### Final deployment checklist

1. **CI is green:** on GitHub, **Actions** shows a green tick for the latest push to `main`.
2. **Backup first:** in Neon, open the project, then **Branches**, **New branch**, from the main branch, named `before-final-deploy`. It is a copy of all the data at that moment, to go back to if something goes wrong. (Neon also keeps a short history it can restore from, but a named branch doesn't expire.)
3. **Migrations:** `npm run migrate:status` with `MIGRATION_DATABASE_URL` set to the live database (`lepara_live`, as the owner). Every migration up to `008` should be applied; if any is pending, run `npm run migrate:up`.
4. **Reference data only:** `npm run seed` (never `seed:sample` on the live database: it adds placeholder events and products). It is safe to run again.
5. **Settings on Render:** check the environment variables listed above. When the website has its final address, set `CORS_ORIGINS` to it (several addresses are separated by commas).
6. **Deploy:** Render deploys each push to `main` by itself. Wait for "Live", then open `/api/v1/health` and `/api/docs`.
7. **Read the first logs:** in Render, **Logs**. Look for the start-up line, the email service line ("Emails are sent through Brevo's web API") and no `ERROR` lines after a few requests.
8. **Test accounts:** signed in as the first super admin, add the lecturer's admin with `POST /admin/users` (`role: "super_admin"`) and put the username and temporary password in the private submission. Register a customer with an email address you can read, confirm it with the emailed code, and put the email and password in the private submission.
9. **Real content:** add the shop's real products and opening stock with the admin endpoints (`/api/docs` or Postman), and the first events and news.
10. **On GitHub:** **Settings → Code security**: check that **Secret scanning** and **Push protection** are on.

## How the code is organised

```
src/
  server.ts              starts the server, shuts down cleanly
  app.ts                 middleware order, routes, error handler
  routes.ts              mounts each module under /api/v1
  docs.ts                serves the API documentation at /api/docs
  config/                environment check, database pool and transactions
  middleware/            validation, error handler, not-found, rate limits, admin sign-in check, roles,
                         photo uploads, the forms' spam trap, Idempotency-Key for orders
  services/              connections to outside services (photo storage in Azure, email and its templates;
                         push notifications through Firebase)
  modules/<feature>/     routes → controller → service → repository (Task 1, Section 6.2)
  schemas/common.ts      shared validation rules with user-facing messages
  utils/                 errors, money in cents, dates, paging, reference numbers, safe sorting, CSV files,
                         authenticator codes (totp.ts), encryption and hashing (crypto.ts), audit log
db/
  migrations/            numbered SQL files, each with an up and a down section
  seeds/                 reference and sample data
  setup/                 the limited app user
docs/
  openapi.yaml           the API documentation (OpenAPI 3.1), shown at /api/docs
  lepara-api.postman_collection.json   every request, for Postman
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
| 007 | `VOLUNTEER_APPLICATION`: decision reason; a declined application, request or pledge must have a reason | Task 1 requires a reason to decline (Section 7.6); the decision email includes it |
| 008 | `CUSTOMER`: session version, last sign-in | Signing a customer out everywhere at once (password change, reset, deletion) |
