# VK ID Android Auth Without SDK — Design Spec

**Date:** 2026-03-24
**Status:** Implemented
**Replaces:** `2026-03-24-vk-oauth-server-callback-design.md`

---

## Context

VK's documentation for Android auth without SDK (`id.vk.ru`) describes a native deep link approach:
- Redirect URI is `vk{APP_ID}://vk.ru/blank.html` — a native Android deep link, not HTTPS
- VK automatically whitelists `vk{APP_ID}://vk.ru` for Android apps — no Standalone app type required
- Token exchange uses `id.vk.ru/oauth2/auth` (POST, PKCE, no `client_secret` required)
- Previous approach used `id.vk.com` (wrong domain) and server-side redirect (unnecessary complexity)

---

## Architecture

```
App                           VK                   Server
 │                              │                      │
 │  Generate (expo-crypto):     │                      │
 │    code_verifier (random)    │                      │
 │    code_challenge (SHA-256)  │                      │
 │    state (random)            │                      │
 │  Store PKCE at module level  │                      │
 │                              │                      │
 │  WebBrowser.openAuthSessionAsync                    │
 │  → id.vk.ru/authorize        │                      │
 │    client_id=54501952        │                      │
 │    redirect_uri=             │                      │
 │      vk54501952://vk.ru/     │                      │
 │      blank.html?oauth2_params│                      │
 │    code_challenge=...        │                      │
 │    state=...                 │                      │
 │    response_type=code        │                      │
 │──────────────────────────────►                      │
 │                              │                      │
 │◄── vk54501952://vk.ru?───────│                      │
 │      code=...                │                      │
 │      state=...               │                      │
 │      device_id=...           │                      │
 │                              │                      │
 │  Deep link → Expo Router     │                      │
 │  +not-found.tsx catches it   │                      │
 │  Verify state matches        │                      │
 │                              │                      │
 │  POST /auth/vk/exchange ─────────────────────────►  │
 │  { code, code_verifier,      │  POST id.vk.ru/      │
 │    device_id }  (snake_case) │  oauth2/auth         │
 │                              │◄─────────────────────│
 │                              │── access_token ─────►│
 │                              │  POST user_info       │
 │                              │  createUser()         │
 │                              │  sign JWT (7d)        │
 │◄── { token } ────────────────────────────────────── │
 │                              │                      │
 │  SecureStore(token)          │                      │
 │  GET /auth/me ───────────────────────────────────►  │
 │◄── { user } ─────────────────────────────────────── │
 │  navigate /home              │                      │
```

### Deep Link Handling (Android-specific)

`WebBrowser.openAuthSessionAsync` does NOT reliably intercept the VK redirect on Android. When VK redirects to `vk54501952://vk.ru/blank.html?code=...`, the deep link arrives at Expo Router, which can't match any file-system route. The solution:

1. **`+not-found.tsx`** catches the unmatched deep link
2. Reads VK callback params (`code`, `device_id`, `state`) via `useGlobalSearchParams`
3. Retrieves PKCE from module-level storage in `useVKAuth.ts`
4. Exchanges code with server, logs in, navigates to `/home`

PKCE params are stored at module level (not in React state) so they survive the component remount when Expo Router navigates away from `/login` to `+not-found`.

---

## VK Console Setup

- App type: **Android** (unchanged — `vk{APP_ID}://vk.ru` is automatically whitelisted)
- No redirect URI registration needed

---

## Server

### `POST /auth/vk/exchange`

Replaces `GET /auth/vk/callback`.

**Request body (snake_case to match VK convention):**
```json
{ "code": "...", "code_verifier": "...", "device_id": "..." }
```

Server destructures with rename: `{ code, code_verifier: codeVerifier, device_id: deviceId }`.

**Success flow:**
1. Validate `code`, `code_verifier`, `device_id` present — else 400
2. `exchangeCode({ code, codeVerifier, deviceId, redirectUri: 'vk54501952://vk.ru/blank.html', clientId })`
3. `fetchUserProfile(accessToken, clientId, deviceId)`
4. `createUser(profile)`
5. Sign JWT (7d)
6. Return `{ token }`

**Error responses:** JSON `{ error, message }` — 400 for missing fields, 401 for VK rejection.

### `GET /auth/me` — unchanged

### `vk.js`

**`exchangeCode`:**
- `POST https://id.vk.ru/oauth2/auth`
- Params: `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `device_id`, `redirect_uri`
- No `client_secret`
- Returns `{ accessToken, userId, idToken }`

**`fetchUserProfile`:**
- `POST https://id.vk.ru/oauth2/user_info`
- Params: `access_token`, `device_id`; `client_id` as query param
- Returns `{ vkId, firstName, lastName }`

---

## App

### `app.json`

- Schemes: `["vkoauth", "vk54501952"]`
- Intent filter: `vk54501952://vk.ru` with `BROWSABLE` + `DEFAULT` categories

### `useVKAuth.ts`

Uses **`expo-crypto`** (not `crypto.subtle` — Hermes doesn't support it):
- `Crypto.getRandomValues()` for random bytes
- `Crypto.digestStringAsync(SHA256, ..., BASE64)` for code challenge

Module-level PKCE storage exported via `getStoredPKCE()` / `clearStoredPKCE()`.

Two code paths for handling the VK redirect:
1. **Fast path:** `openAuthSessionAsync` returns `{ type: 'success', url }` — process directly in the hook
2. **Fallback path (Android):** Deep link goes to Expo Router → `+not-found.tsx` handles it using stored PKCE

### `+not-found.tsx`

Catches VK redirect deep links that Expo Router can't match:
- Detects VK callback via `code` + `device_id` in search params
- Retrieves PKCE from module-level storage
- Validates state, exchanges code, logs in, navigates to `/home`
- Shows error with "Back to login" button on failure
- Non-VK 404s redirect to `/`

### `api.ts`

`exchangeVKCode` sends **snake_case** keys (`code_verifier`, `device_id`) to match VK convention. Includes 15-second `AbortController` timeout.

### `config.ts`

- `API_URL` — `http://192.168.87.125:5173` for local testing, `https://mz.ludentes.ru` for production
- `VK_CLIENT_ID` — `'54501952'`

### `AndroidManifest.xml`

- `android:usesCleartextTraffic="true"` — required for HTTP during local testing

---

## Known Limitations

1. **VK "One tap sign-in" modal** — appears when VK app is installed on device. Cannot be suppressed via OAuth parameters (`prompt=login`, `display=page` both tested, neither works). User must dismiss it or tap "Enter info manually".

2. **Cloudflare blocks React Native fetch** — React Native's OkHttp client is blocked by Cloudflare when hitting `mz.ludentes.ru`. Local IP (`http://192.168.87.125:5173`) works. Production deployment needs Cloudflare bypass (e.g., whitelist the app's user agent, or use Cloudflare tunnel with skip-challenge rules).

3. **`client_id` placement in `fetchUserProfile`** — currently sent as query param. VK may expect it in POST body. Verify during E2E testing.

---

## Error Handling

| Scenario | Caught by | Result |
|---|---|---|
| User cancels browser | `useVKAuth` (`result.type !== 'success'`) | Loading reset, stay on login |
| State mismatch | `+not-found.tsx` | Error shown with "Back to login" |
| Auth session expired (PKCE lost) | `+not-found.tsx` | Error shown with "Back to login" |
| Server unreachable | `+not-found.tsx` (AbortController 15s) | "Aborted" error shown |
| VK rejects code | Server returns 401 JSON | Error shown |
| `GET /auth/me` fails on startup | `useAuth.checkAuth` | Token deleted, stay on login |

---

## Testing

**Server (Jest + supertest, 19 tests pass):**
- `POST /auth/vk/exchange`: success case, missing fields (400), VK exchange failure (401)
- `GET /auth/me`: valid token, missing token (401)
- `vk.js`: `exchangeCode` POSTs to `id.vk.ru/oauth2/auth`, throws on error; `fetchUserProfile` POSTs to `id.vk.ru/oauth2/user_info`

**App:** Manual E2E testing on device — VK web login flow works with local server.

---

## Security Notes

- `client_secret` not needed for token exchange (PKCE replaces it) — but kept in `.env` for future use
- `state` verified client-side to prevent CSRF
- `device_id` comes from VK (returned in callback) — used in all subsequent requests
- JWT stored in SecureStore (encrypted)
- App→server API uses snake_case keys (`code_verifier`, `device_id`) matching VK convention
