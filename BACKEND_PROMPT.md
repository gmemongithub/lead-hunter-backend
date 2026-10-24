# Backend brief: Lead Hunter

You are building the backend for **Lead Hunter**, a Chrome/Edge extension (side panel) that extracts business leads from Google Maps. Read the whole brief, then build it.

## 1. Where the backend fits

- All scraping, filtering, result storage and export happen **inside the user's browser**. The backend never receives lead data.
- **Do not build** any endpoint for searches, results, fields, filters or exports. Nothing about those features touches the server.
- The backend does three things only: **accounts, licenses, devices**.
- The product is sold directly (no app store). A customer gets an email + password and a time-limited license: 1 Month, 3 Months, 6 Months, 1 Year or Lifetime.
- The extension is currently used by one person with login turned off. This backend is what will turn login on.

## 2. What the extension does (context, no backend work)

| Screen  | What the user does                                                                                              | Backend involvement |
| ------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| Search  | Single keyword or bulk keywords (bulk runs one keyword at a time), Start / Pause / Stop, live progress          | Start is blocked when the license is not active |
| Fields  | Choose columns: Business Name, Address, Phone, Website, Category, Rating, Review Count, Opening Hours; enrichment: Email, Facebook, Instagram, LinkedIn; extra: Lead Score, Lead Status, Source Keyword, Maps URL, Coordinates | none |
| Filters | Before run: min rating, min reviews, has website, no website, has email. After run: min lead score, email found, website found, source keyword, lead status | none |
| Results | Table (Business, Score, Email, Phone, Website, Rating, Source), Expand to a bigger popup, delete selected, retry failed, clear master list | none |
| Export  | CSV or Excel; rows: All / Filtered / Selected                                                                   | none |
| Profile | Name, email, plan, expiry date, days left, device list with Remove, Log out                                     | endpoints 1 to 6 below |

"Days left" is shown only inside Profile, not on the main panel. The only main-panel effect of the backend is a red banner "Your license is not active." plus a blocked Start button.

## 3. How the extension behaves (your server must support this)

- JSON over HTTPS, `Authorization: Bearer <accessToken>`. Base URL is configurable in the extension.
- **Device id**: a UUID v4 generated once per install and sent on login and license verify. **Device name** is text like `Chrome on Windows`.
- After login the extension stores `accessToken`, `refreshToken`, `user`, `license` locally.
- On any `401` for a protected call the extension calls `POST /auth/refresh` **once** and retries. If refresh also returns `401` the user is logged out locally.
- On panel open and every 12 hours it calls `POST /license/verify`. If the network is down it keeps using the cached license.
- The license is usable when `status == "active"` and (`term == "lifetime"` or `expiresAt` is in the future). Otherwise Start is blocked and the banner shows.
- **Login must succeed (200) for an expired license** and return the license with `status: "expired"`. Do not answer 403 for that, or the user can never reach Profile to see the expiry.
- The `message` field of an error is shown to the user as-is on the login screen. Write short, friendly English sentences.
- Unknown extra fields in responses are ignored, so adding fields is safe.

## 4. API

Time values are ISO 8601 UTC. Errors always look like:

    { "code": "invalid_credentials", "message": "Wrong email or password." }

| HTTP | code                 | When                                                      |
| ---- | -------------------- | --------------------------------------------------------- |
| 400  | bad_request          | invalid body                                              |
| 400  | cannot_remove_current| DELETE on the caller's own device                         |
| 401  | invalid_credentials  | wrong email/password on login (use one message for both)  |
| 401  | invalid_token        | access token missing, expired or revoked                  |
| 401  | invalid_refresh      | refresh token unknown, expired, reused or revoked         |
| 403  | device_limit_reached | new device but the license device limit is used up        |
| 404  | not_found            |                                                           |
| 429  | rate_limited         | with `Retry-After` header                                 |
| 5xx  | server_error         |                                                           |

License object (used in several responses):

    {
      "status": "active",                      // active | expired | revoked | suspended
      "term": "3m",                            // 1m | 3m | 6m | 1y | lifetime
      "expiresAt": "2026-12-20T00:00:00Z",     // null for lifetime
      "deviceLimit": 2
    }

The server decides `status`. Compute `expired` from `expiresAt` on every response, do not rely on a stored flag.

### 1. POST /auth/login  (no auth)

    { "email": "a@b.com", "password": "...", "deviceId": "uuid", "deviceName": "Chrome on Windows" }

200:

    { "accessToken": "...", "refreshToken": "...",
      "user": { "id": "u_1", "name": "Jane Doe", "email": "a@b.com" },
      "license": { ...License } }

Errors: 401 invalid_credentials, 403 device_limit_reached, 429 rate_limited.
A new `deviceId` is registered (limit checked). A known one only gets `lastSeenAt` updated.
Access token about 15 minutes. Refresh token about 30 days and **rotating**.

### 2. POST /auth/refresh  (no auth)

    { "refreshToken": "..." }   ->   200 { "accessToken": "...", "refreshToken": "..." }

The old refresh token becomes invalid. If an already-used refresh token is presented again, revoke that device's tokens (reuse detection) and answer 401 invalid_refresh.

### 3. POST /auth/logout

    { "deviceId": "uuid" }   ->   200 {}

Revokes that device's refresh tokens. The device record stays (it still counts toward the limit) until it is removed with endpoint 6.

### 4. POST /license/verify

    { "deviceId": "uuid" }   ->   200 { "license": { ...License }, "serverTime": "2026-09-20T10:00:00Z" }

Updates the device `lastSeenAt`. If the device was removed or revoked, answer 401 invalid_token. The extension then tries `/auth/refresh`, which must also return 401 for that device, and logs the user out. The extension does not use `serverTime` yet but will, so always send it.

### 5. GET /devices

    200 { "devices": [ { "id": "uuid", "name": "Chrome on Windows", "lastSeenAt": "...", "current": true } ] }

`current` is true for the device that owns the access token used for this request.

### 6. DELETE /devices/{id}

200 `{}`. Deleting the caller's own device returns 400 cannot_remove_current. Deleting another device revokes its tokens; that device gets 401 on its next call and is logged out.

## 5. Admin side (not called by the extension, but needed to sell)

There is no website or payment yet, so the owner must be able to do the following, protected by a single secret (`X-Admin-Key` header from an env var), or as a CLI script if that is simpler:

- create a user with a term (returns a one-time temporary password, or accepts one)
- extend or replace a license term, revoke or suspend a license
- reset a password
- list users, and list / remove a user's devices

Registration, payment and forgot-password will live on a website later. The extension only opens links to it.

## 6. Data model (suggestion)

- users: id, email (unique, lowercase), name, password_hash, created_at
- licenses: id, user_id, term, status, starts_at, expires_at, device_limit
- devices: id (client UUID), user_id, name, created_at, last_seen_at, revoked_at
- refresh_tokens: id, user_id, device_id, token_hash, expires_at, revoked_at, replaced_by

## 7. Security requirements

- Passwords with argon2id or bcrypt. HTTPS only.
- Store refresh tokens hashed. Rotate them with reuse detection.
- Rate limit login and refresh (per IP and per email).
- Same error and similar timing for unknown email and wrong password.
- The extension is expected to call from `chrome-extension://` origins. It will also have host permission for the API domain, but allow CORS for the configured extension origin(s) anyway.
- Never log passwords or tokens.

## 8. Deliverables

- Working service, README (env vars, run, deploy), migrations, `.env.example`.
- Admin script or endpoints from section 5.
- Automated tests for the acceptance checks below.
- Stack is your choice. The owner has no server yet, so it must be easy to deploy to a small VPS or a serverless platform. Say what you chose and why.

## 9. Acceptance checks

1. Login with a valid user returns 200, tokens, user and an active license.
2. Wrong password and unknown email return the same 401 invalid_credentials.
3. Login for an expired license returns 200 with `status: "expired"`.
4. A protected call with an expired access token returns 401 invalid_token; after `/auth/refresh` the same call works.
5. Reusing an old refresh token returns 401 invalid_refresh and kills that device's session.
6. Logging in from a third device when `deviceLimit` is 2 returns 403 device_limit_reached.
7. `/devices` marks exactly one device as `current`.
8. Removing another device makes that device's next `/license/verify` and `/auth/refresh` return 401.
9. `/license/verify` returns `serverTime` and a lifetime license has `expiresAt: null`.
10. Rate limits trigger 429 with `Retry-After`.

## 10. Open decisions (ask the owner, do not guess)

- **Device limit at login**: a user who hit the limit cannot log in, so cannot remove a device from the extension. Default: return 403 device_limit_reached with a message telling them to contact support, and let the admin remove devices. Alternative: accept an optional `replaceDeviceId` on login.
- Where licenses get issued once a website and payments exist.
- Hosting and domain.
