# License Server

Licensing server for Android apps. Cloudflare Workers + D1 (SQLite). Free, HTTPS out of the box.

---

## Stack

- **Cloudflare Workers** — backend (TypeScript)
- **Cloudflare D1** — database (SQLite)
- **URL** — `https://license-server.YOUR_NAME.workers.dev`

---

## First Deploy

```bash
npm install -g wrangler
wrangler login

# Create DB and copy database_id into wrangler.toml
npx wrangler d1 create license-db

# Apply schema
npx wrangler d1 execute license-db --remote --file=schema.sql

# Deploy
npx wrangler deploy

# Set Admin key
npx wrangler versions secret put ADMIN_KEY
npx wrangler versions deploy
```

## Update (migration)

```bash
npx wrangler d1 execute license-db --remote --file=migrate.sql
npx wrangler deploy
npx wrangler versions secret put ADMIN_KEY
npx wrangler versions deploy
```

---

## API

### Public (called from Android)

| Method | Path | Description |
|---|---|---|
| POST | `/activate` | First launch — register device, issues 3-day trial |
| POST | `/verify` | Check license on every app launch |

**POST /activate**
```json
// Request
{ "email": "user@example.com", "device_id": "abc123", "app_id": "worktrack" }

// Response: new device — trial started
{ "ok": true, "token": "abc...", "status": "trial", "expires_at": 1234567890 }

// Response: already active
{ "ok": true, "token": "abc...", "status": "active", "expires_at": null }

// Response: trial expired
{ "ok": false, "error": "Trial expired", "reason": "trial_expired" }
```

**POST /verify**
```json
// Request
{ "token": "abc...", "device_id": "abc123", "app_id": "worktrack" }

// Response: valid
{ "ok": true, "valid": true, "status": "trial", "expires_at": 1234567890 }

// Response: invalid
{ "ok": false, "valid": false, "reason": "trial_expired" }
// reason: not_found | revoked | expired | trial_expired | device_mismatch
```

---

### Admin (Header: X-Admin-Key)

| Method | Path | Description |
|---|---|---|
| POST | `/admin/create` | Issue a full license |
| POST | `/admin/revoke` | Revoke a license |
| POST | `/admin/restore` | Restore a revoked license |
| GET | `/admin/licenses` | List all licenses |
| GET | `/admin/apps` | Stats per app |

**POST /admin/create**
```json
// Request
{ "email": "user@example.com", "device_id": "abc123", "app_id": "worktrack" }
// expires_days — optional, omit for a perpetual license

// Response
{ "ok": true, "token": "abc...", "action": "created" }
```

**POST /admin/revoke** (and `/admin/restore`)
```json
{ "id": 123 }
```

**GET /admin/licenses**
```
/admin/licenses?app_id=worktrack&active=1
/admin/licenses?email=user@example.com
```

---

## User Flow

```
First launch
  → User enters email
  → POST /activate → token + 3-day trial → app works

Every launch (24h cache)
  → POST /verify → valid=true → continue

Trial expired
  → "Request license" screen → user enters email → POST /activate
  → You activate: POST /admin/create
  → Next launch → status=active → full access

Offline check
  → DataStore cache (24h) → works without internet
```

---

## Adding a New App

No server changes needed — just use a new `app_id`:
```
"app_id": "orderpacker"
"app_id": "fastscan"
```

---

## Android Integration

Place files in `app/src/main/java/.../license/`:
- `LicenseManager.kt` — activation and verification logic
- `LicenseViewModel.kt` — ViewModel
- `LicenseScreen.kt` — UI (Compose)

Usage in `MainActivity.kt`:
```kotlin
setContent {
    AppTheme {
        LicenseGate {
            // main NavHost here
        }
    }
}
```

Dependency in `build.gradle`:
```kotlin
implementation "androidx.datastore:datastore-preferences:1.1.1"
```

---

## Dashboard

Open the deployed Worker at `/admin`. The URL is saved locally; the admin key
is kept only in page memory and must be entered again after reload.

## Optional Firebase authentication and warehouses

Firebase is enabled per license only when `warehouse_id` is assigned. Ordinary
apps omit `country_code` on activation: no warehouse is assigned, and their
existing `/activate` and `/verify` responses contain no warehouse fields or
Firebase token. Existing device activation still requires its stored `token`.
`app_id` selects an application; the exact `warehouse_id` is the data boundary,
not the country or application. Apps sharing `es-main` share its data; `es-2`
and `us-main` are separate warehouses. Country is optional metadata (`ES`, `US`).

FastScan activation example:

```json
{"email":"user@example.com","device_id":"device-id","app_id":"com.ocr.fastscan","app_name":"FastScan","country_code":"US"}
```

A new trial receives `license-{numeric_id}` and the requested country, never a
shared warehouse. Email is contact information only and grants no warehouse
access: every new device gets its own isolated warehouse, even with the same
email, app and country. Without country, a new license has `NULL` warehouse and
country. An existing device keeps its assigned warehouse when authenticated
with its own license token; changing the Android country cannot change access.
Only an administrator assigns shared warehouses (`es-main`, `es-2`, `us-main`),
including sharing a warehouse between different apps through the license panel.
Email verification and one-time device-transfer codes are not implemented.

After approval, use authenticated `POST /admin/warehouse`:

```json
{"id":123,"warehouse_id":"es-2"}
```

`es-*` sets `ES`, `us-*` sets `US`. IDs must match
`^[a-z0-9][a-z0-9-]{0,63}$`. `null` or `""` removes both warehouse and country.
`POST /admin/create` accepts optional `warehouse_id` and `country_code`;
conflicting country and prefix are rejected. No warehouse means no Firebase.
Renewal omitting these fields preserves the assignment. The dashboard offers
Not used / Spain / United States, suggested warehouses, custom IDs and removal.

Successful warehouse responses add `warehouse_id`, `country_code`, and, when
configured, `firebase_token`; all existing fields and HTTP statuses remain.
The token is an RS256 Firebase Custom Token, signed with Web Crypto, valid for
one hour, with `uid: license:{id}` and claims `warehouse_id`, `country_code`,
`license_active: true`, `license_expires_at` (Unix seconds, `0` for perpetual),
`license_id`, `app_id`. Exchange it using Firebase `signInWithCustomToken` in
project `fastscan-pro-1816f`. A Custom Token is not itself a Firebase ID token.
Missing or invalid signing configuration logs a safe error and does not stop
licensing; the response omits `firebase_token`. `GET /health` returns
`{"ok":true,"firebase_auth_configured":true}` only when all three variables
are present; this checks presence, not key validity.

The repository includes `firestore.rules` for `/warehouses/{warehouseId}` and
all nested documents. It requires an authenticated token with a nonempty string
`warehouse_id` and exact `request.auth.token.warehouse_id == warehouseId`, plus
an active, unexpired license. Missing claims deny access. Neither email, app ID
nor country grants warehouse access. As a temporary compatibility exception,
historical root documents `/shipments/{id}` and `/box_entries/{id}` can be read
only by active, unexpired `es-main` licenses. Writes and access to their
subcollections are denied. `es-2`, `us-main`, isolated warehouses and tokens
without `warehouse_id` cannot read these legacy collections. All other root
collections are denied.
Apply these rules to Firestore separately after reviewing your existing rules;
no Firebase rules are deployed by the Worker. Remove any overlapping permissive
rule: Firestore combines matching allow rules with OR.

Firebase Security Rules must check the exact signed `warehouse_id`, active
license and expiration on every warehouse data path. Never authorize using the
Android country setting or country claim alone. Removing access or revoking a
license stops new Custom Tokens; existing Firebase sessions need Security Rules
with expiry checks and, if immediate revocation is required, a server-managed
revocation mechanism. Token claims alone do not invalidate an existing session.

### Configuration and one-time migration

`FIREBASE_PROJECT_ID = "fastscan-pro-1816f"` is configured in `wrangler.toml`.
Store `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` only as Cloudflare
Secrets. The private key must be a PKCS#8 PEM (`BEGIN PRIVATE KEY`); literal
`\n` separators are also accepted. Never commit private keys, service-account
JSON, or local secret files.

For an existing database, apply `0002-security.sql` first if needed, then run
this migration **exactly once**, before deploying the new Worker. It adds the
columns/index and assigns **only** existing `com.ocr.fastscan` licenses to
`es-main` / `ES`. Other applications remain `NULL` / `NULL`. Repeating the ALTER
statements fails. For a fresh database, use only `schema.sql`, not this migration.

```bash
npx wrangler d1 execute license-db --remote \
  --file=migrations/0003-firebase-auth.sql

npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY

npx wrangler deploy
```

Firestore Rules emulator checks (Java 21+ required):

```bash
npm run test:rules
```

This starts only a local Firestore emulator with project `demo-license-server`.
No service-account JSON or Firebase login is needed. Tests cover exact warehouse
isolation, sharing across apps, missing claims, country/email independence,
license expiry, read-only legacy collections for `es-main`, and denial of other
root collections. This command does not publish rules or deploy the Worker.

Local checks (do not alter remote D1):

```bash
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler d1 execute license-db --local --file=schema.sql
```

## License archive

The `/admin` dashboard provides **«В архив»** (Archive), **«Вернуть из архива»**
(Unarchive), and a **«Текущие / Архив / Все»** (Current / Archive / All) filter.
Current licenses are shown by default. Statistics and app filters describe the
loaded list (up to 100 records).

Archiving only hides a record: token, active status, expiry, warehouse and Firebase
access stay unchanged. Use **Revoke** separately to disable an old device.
Unarchiving does not restore a revoked license. Renewal preserves archive state.
Nothing is archived or deleted automatically.

For existing installations, add the archive table before deploying the Worker.
This migration is safe to repeat and does not modify existing licenses. Fresh
installations already include the table in `schema.sql`.

```bash
git pull origin master
npm ci
npx wrangler d1 execute license-db --remote --file=migrations/0004-license-archive.sql
npx wrangler deploy
```

Admin API (requires `X-Admin-Key`):

- `POST /admin/archive` with `{"id":123,"archived":true}` to archive,
  or `{"id":123,"archived":false}` to unarchive.
- `GET /admin/licenses?archived=0` for current (default), `archived=1` for
  archived, `archived=all` for both.

Archive filtering precedes the row limit. Changes are audited. Public `/activate`
and `/verify` ignore archive state.
