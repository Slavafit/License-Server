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

**POST /admin/revoke**
```json
{ "token": "abc..." }
// or
{ "device_id": "abc123", "app_id": "worktrack" }
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

Open `license-dashboard.html` in any browser. Settings (URL + key) are saved locally.
