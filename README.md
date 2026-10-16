# Lepara Ale fele Moya API

The back end for the Lepara Ale fele Moya mobile app and website: Node.js, Express 5, TypeScript and a cloud PostgreSQL database. One API serves both apps; the admin dashboard on the website uses the `/api/v1/admin` routes added in later phases.

Built so far, following the build guide:

- **Phase 1 (Foundation):** the project skeleton, the app shell with error handling, the database migrations and seeds, the shared building blocks, tests and CI.
- **Phase 2, Step 5:** admin sign-in with an authenticator app (two-factor authentication), sessions, lockout and password change.
- **Phase 2, Step 6:** admin user management: super admins add, edit and deactivate admins, and reset a lost authenticator or a forgotten password.
- **Phase 2, Step 7:** events: the public event list and pages for the app, event types, volunteer tasks, and photo uploads to Azure Blob Storage.
- **Phase 2, Step 8:** announcements for the app's News screen.
- **Phase 2, Step 9:** the shop: products, sizes with stock, categories and product photos.
- **Phase 3, Step 10:** the four public forms (volunteer, donation pledge, request help, enquiry), with reference numbers and confirmation emails.
- **Phase 3, Step 11:** "Track my request": the status of a volunteer application, pledge or request for help, from its reference number and phone digits.
- **Phase 3, Step 12:** the admin review queues: accept or decline volunteers, requests for help and pledges (with a decision email), record attendance, close requests, mark enquiries reviewed.
- **Phase 3, Step 13:** donations and stock: recording and voiding donations, stock items and adjustments, receiving pledges, and fulfilling requests from stock.

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

Each announcement has `announcementId`, `title`, `body`, `publishedAt` and `dateLabel`, the publishing date in Johannesburg written like `"16 Oct 2026"`. The admin replies also have `isActive` and `publishedBy`. Titles are 5 to 120 characters and the text is 10 to 2,000. Publishing will also send a push notification once step 17 is built.

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
| Step 7: drafts never appear in the public list; Upcoming and Completed follow the Johannesburg date | `tests/integration/initiatives.test.ts`, `tests/unit/initiatives.test.ts` |
| Step 7: moving a closed event back to draft gets a friendly error | `tests/integration/initiatives.test.ts` |
| Step 7: a renamed non-image file gets 415; a file over 2 MB gets 413 | `tests/integration/initiatives.test.ts`, `tests/unit/initiatives.test.ts` |
| Step 7: a task with volunteer applications can't be deleted; type names are unique | `tests/integration/initiatives.test.ts` |
| Step 8: hidden announcements never appear publicly; the public list is newest first and paginated | `tests/integration/announcements.test.ts` |
| Step 9: inactive products are hidden from the public; a search for `'; DROP TABLE product; --` returns an empty list | `tests/integration/products.test.ts` |
| Step 9: stock shows as In stock, Low stock or Sold out; sizes and SKU codes are unique | `tests/integration/products.test.ts`, `tests/unit/products.test.ts` |
| Step 10: each form returns a reference number and emails it; a draft or ended event gets a friendly refusal; the 6th form in 10 minutes gets 429; an unticked consent box gets 400 on `consent` | `tests/integration/submissions.test.ts`, `tests/unit/submissions.test.ts` |
| Step 10: a filled-in spam-trap field gets a pretend success and saves nothing | `tests/integration/submissions.test.ts`, `tests/unit/submissions.test.ts` |
| Step 10: an unreachable mail server is retried 3 times, then logged; the form is saved and answered straight away | `tests/unit/email.test.ts` (and by hand, below) |
| Step 11: the right reference and digits return the status; a wrong reference and wrong digits give identical replies | `tests/integration/tracking.test.ts` |
| Step 11: the reply holds no personal details; the 6th wrong attempt gets 429 | `tests/integration/tracking.test.ts`, `tests/unit/tracking.test.ts` |
| Step 12: declining without a reason gets 400; deciding an already decided submission gets 409 | `tests/integration/reviews.test.ts`, `tests/unit/reviews.test.ts` |
| Step 12: the person gets the decision email and tracking shows the new status; every decision records the admin and an audit row | `tests/integration/reviews.test.ts` |
| Step 13: a goods donation raises stock by exactly its quantity, and a forced error halfway saves nothing; a monetary donation with a quantity is rejected | `tests/integration/stock.test.ts`, `tests/unit/stock.test.ts` |
| Step 13: two fulfilments at once for the last 5 blankets: one succeeds, the other gets 409; voiding after the goods were given out gets 409 | `tests/integration/stock.test.ts` |
| Step 13: each item's movements add up to its quantity on hand | `tests/integration/stock.test.ts` |

To check by hand that a form still saves when email is down, put `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1` and any `MAIL_FROM` in `.env`, run `npm run dev` and send a form. The reply comes at once with a reference number; about 7 seconds later the terminal shows two "trying again" warnings and then "Email could not be sent after 3 tries". Remove those lines afterwards.

To check by hand that the app user cannot drop a table, connect as `lepara_app` and run `DROP TABLE donation;`. It should fail with "must be owner of table donation".

## Deploying (Azure App Service or Render)

- **Runtime:** Node 22, Linux
- **Build command:** `npm ci --include=dev && npm run build && npm prune --omit=dev` (TypeScript is a dev dependency, so it must be installed to build)
- **Start command:** `npm start`
- **Health check path:** `/api/v1/health`
- **Environment variables:** `NODE_ENV=production`, `DATABASE_URL` (the `lepara_app` user), `DATABASE_SSL=true`, `TRUST_PROXY=1`, `CORS_ORIGINS` (the website's address), `LOG_LEVEL=info`, `JWT_ADMIN_SECRET`, `TOTP_ENCRYPTION_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, and for email `BREVO_API_KEY` and `MAIL_FROM` (on Render's free plan SMTP is blocked, so use Brevo's API there). The host sets `PORT`.
- **Never change `TOTP_ENCRYPTION_KEY` on the live server** once admins have set up 2FA: their authenticator apps would stop working and each would need 2FA reset.

Run `npm run migrate:up` from your own machine, with `MIGRATION_DATABASE_URL` pointing at the cloud database, before deploying code that needs new tables.

## How the code is organised

```
src/
  server.ts              starts the server, shuts down cleanly
  app.ts                 middleware order, routes, error handler
  routes.ts              mounts each module under /api/v1
  config/                environment check, database pool and transactions
  middleware/            validation, error handler, not-found, rate limits, admin sign-in check, roles,
                         photo uploads, the forms' spam trap
  services/              connections to outside services (photo storage in Azure, email and its templates;
                         push notifications from step 17)
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
| 007 | `VOLUNTEER_APPLICATION`: decision reason; a declined application, request or pledge must have a reason | Task 1 requires a reason to decline (Section 7.6); the decision email includes it |
