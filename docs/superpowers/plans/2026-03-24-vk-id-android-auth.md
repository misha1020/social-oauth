# VK ID Android Auth Without SDK — Implementation Plan

> **Status:** Tasks 1–6 complete. Tasks 7–8 partially done (local testing works, production deployment pending Cloudflare fix).

**Goal:** Replace the current server-side OAuth callback with VK's native Android deep link approach: the app opens `id.vk.ru/authorize`, VK redirects directly to `vk54501952://vk.ru` (intercepted natively), and the app sends `{code, code_verifier, device_id}` to the server for exchange.

**Architecture:** App generates PKCE and opens `id.vk.ru/authorize` with `redirect_uri=vk54501952://vk.ru/blank.html`. VK redirects back with `code + device_id + state` via Android intent. Expo Router's `+not-found.tsx` catches the deep link (since `openAuthSessionAsync` doesn't reliably intercept on Android). The component verifies state, calls `POST /auth/vk/exchange` on the server. Server exchanges with `id.vk.ru/oauth2/auth` (no client_secret), fetches profile from `id.vk.ru/oauth2/user_info`, creates user, and returns a JWT.

**Tech Stack:** Express (Node.js), supertest (server tests), expo-web-browser, expo-crypto, expo-secure-store, expo-router, TypeScript.

**Spec:** `docs/superpowers/specs/2026-03-24-vk-id-android-auth-design.md`

---

## File Structure

```
server/
  src/index.js              - Express entry, request logging middleware
  src/routes/auth.js        - POST /vk/exchange (snake_case body keys)
  src/services/vk.js        - id.vk.ru endpoints, no client_secret
  src/services/users.js     - File-based user CRUD
  src/middleware/auth.js     - JWT verification

app/
  app.json                  - Schemes + intentFilter for vk54501952://vk.ru
  app/+not-found.tsx        - Catches VK redirect deep link, exchanges code
  app/_layout.tsx            - AuthContext provider + Stack
  app/login.tsx             - VK login button
  app/home.tsx              - Authenticated screen
  src/hooks/useVKAuth.ts    - PKCE + openAuthSessionAsync + module-level PKCE storage
  src/hooks/useAuth.ts      - JWT-based auth state
  src/services/api.ts       - exchangeVKCode (snake_case, 15s timeout) + getMe
  src/config.ts             - API_URL, VK_CLIENT_ID
```

---

## Chunk 1: Server — COMPLETE

### Task 1: Replace GET /vk/callback with POST /vk/exchange ✅

**Deviation from plan:** Server accepts snake_case keys (`code_verifier`, `device_id`) per user decision to match VK convention. Destructures with rename: `{ code_verifier: codeVerifier, device_id: deviceId }`. Tests updated accordingly.

### Task 2: Update vk.js to id.vk.ru endpoints ✅

No deviations. 19 server tests pass.

---

## Chunk 2: App — COMPLETE

### Task 3: Add Android intent filter to app.json ✅

No deviations.

### Task 4: Rewrite useVKAuth.ts ✅

**Deviations from plan:**
- **expo-crypto instead of crypto.subtle** — Hermes JS engine doesn't have `crypto.subtle`. Uses `Crypto.getRandomValues()` and `Crypto.digestStringAsync(SHA256, ..., BASE64)`.
- **Module-level PKCE storage** — `_storedPKCE` stored at module level with exported `getStoredPKCE()` / `clearStoredPKCE()`. Required because Expo Router navigates away from `/login` when VK redirect deep link arrives.
- **`+not-found.tsx` added** — `openAuthSessionAsync` doesn't intercept the VK redirect on Android. The deep link goes to Expo Router which can't match it. `+not-found.tsx` catches it, reads PKCE from module storage, exchanges code, logs in, navigates to `/home`.

### Task 5: Update api.ts ✅

**Deviations from plan:**
- Sends snake_case keys (`code_verifier`, `device_id`) in POST body
- Added 15-second `AbortController` timeout to prevent infinite hang

---

## Chunk 3: Build & Deploy — PARTIAL

### Task 6: Rebuild APK ✅

**Additional change:** `android:usesCleartextTraffic="true"` added to AndroidManifest.xml for HTTP local testing.

### Task 7: Deploy server — PARTIAL

Server runs locally on port 5173. `mz.ludentes.ru` (Cloudflare) responds to curl/browser but **blocks React Native's OkHttp fetch** (requests never reach origin server). Local IP (`http://192.168.87.125:5173`) works for testing.

**TODO:** Fix Cloudflare to allow React Native requests (whitelist user-agent, adjust WAF rules, or use Cloudflare tunnel with skip-challenge config).

### Task 8: End-to-end test — PARTIAL

**Working:**
- VK web login flow (dismiss one-tap modal → enter credentials or confirm saved session → redirect back to app → code exchange → JWT → home screen)
- Server receives and processes requests via local IP

**Known issues:**
- VK "One tap sign-in" modal can't be suppressed — user dismisses it manually
- VK mobile app auth flow redirects to browser instead of app — not fixable without VK SDK
- Cloudflare blocks production requests from React Native — needs Cloudflare config fix
