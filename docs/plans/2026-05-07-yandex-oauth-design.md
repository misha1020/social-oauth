# Yandex OAuth Native SDK — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Target codebase:** `/app-sdk` (Expo custom dev build) + `/server` (Node/Express)

## Goal

Add "Sign in with Yandex" to the test app such that tapping the button opens an installed Yandex app (Browser / Mail / Go / Pro / Alisa) for one-tap SSO confirmation, falling back to a Chrome Custom Tab / WebView when no Yandex app is present. This mirrors the role of the native VK SDK already integrated under `/app-sdk/modules/expo-vk-sdk`.

The end-state code from this test project is meant to be transplanted into the main mobile app once it is proven to work locally on Android.

## Strategy decision

The "opens Yandex app" UX is only available via the native Yandex ID SDK (`com.yandex.android:authsdk` v3.2.0 on Android, `YandexLoginSDK` on iOS). A pure browser/PKCE flow analogous to the existing `/app/src/hooks/useVKAuth.ts` cannot trigger inter-app handoff. We therefore extend the existing `/app-sdk` (custom dev build) rather than `/app`.

## Architecture

```
/app-sdk (Expo, custom dev build, Android + iOS)
  modules/expo-yandex-sdk
    android/  (Kotlin)  ──── com.yandex.android:authsdk:3.2.0
    ios/      (Swift)   ──── YandexLoginSDK
  plugins/withYandexSDK   ─── manifest placeholders, Info.plist scheme
  app/login.tsx           "Sign in with Yandex" button alongside VK

       │ access_token
       ▼
/server (Node/Express)
  POST /auth/yandex/exchange
    1. validate token via GET https://login.yandex.ru/info
    2. upsert user (new generic {provider, providerId} schema)
    3. issue JWT
```

Key point: the Yandex SDK does the OAuth code-for-token exchange internally. The app receives an `access_token` directly — there is no PKCE handshake exposed to client code, no `code_verifier`. The backend's only job is token validation, user upsert, and JWT issuance.

## Components — file map

### New files

```
/app-sdk/modules/expo-yandex-sdk/
  expo-module.config.json          { platforms: [android, ios],
                                     android.modules:
                                       [expo.modules.yandexsdk.ExpoYandexSDKModule],
                                     ios.modules:
                                       [ExpoYandexSDKModule] }
  index.ts                         export { authorize } from "./src"
  src/index.ts                     wrapper around requireNativeModule("ExpoYandexSDK")
                                   exposes async authorize(): Promise<YandexAuthResult>
  src/ExpoYandexSDK.types.ts       type YandexAuthResult =
                                     { accessToken: string; expiresIn: number }
                                     | { cancelled: true }
  android/build.gradle             implementation "com.yandex.android:authsdk:3.2.0"
  android/src/main/.../ExpoYandexSDKModule.kt
                                   - YandexAuthSdk.create(YandexAuthOptions(...))
                                   - registers ActivityResultContract through
                                     ExpoModulesCore activity hook
                                   - resolves Promise on result
  ios/ExpoYandexSDK.podspec        depends on YandexLoginSDK
  ios/ExpoYandexSDKModule.swift    YXLoginSDK.shared.authorize, handleOpenURL

/app-sdk/plugins/withYandexSDK.js
  - Android: manifestPlaceholders["YandexClientID"] = clientId
  - iOS: Info.plist CFBundleURLSchemes += "yx<clientId>"

/app-sdk/src/hooks/useYandexAuth.ts
  Mirrors useVKAuth shape: { authorize, isLoading, error }
  No PKCE state to track — single-step.

/server/src/services/yandex.js
  fetchUserProfile(accessToken):
    GET https://login.yandex.ru/info?format=json
    Header: Authorization: OAuth <token>
    Returns { id, login, email?, firstName, lastName, avatarId? }
```

### Modified files

```
/app-sdk/app.json                  + plugin entry: ["./plugins/withYandexSDK", { clientId }]
/app-sdk/src/services/api.ts       + exchangeYandexToken({ accessToken })
/app-sdk/app/login.tsx             + "Sign in with Yandex" button

/server/src/routes/auth.js         + POST /yandex/exchange handler
                                   VK route updated to use new generic users.js
/server/src/services/users.js      REWRITTEN — generic schema:
                                     findByProvider(provider, providerId)
                                     createUser({ provider, providerId, ... })
                                     User row: { id, provider, providerId,
                                                 firstName, lastName, email?,
                                                 avatarId?, createdAt }
/server/src/index.js               passes yandexAppId from .env to routes
/server/.env                       + YANDEX_CLIENT_ID=<from registration>
/server/data/users.json            wiped on first run
```

### One-time external setup

Register at `oauth.yandex.com/client/new`:
- Platforms: **Android** and **iOS**
- Android: `applicationId` = `com.vkoauth.appsdk` (matches `/app-sdk/app.json`)
- Android SHA-256 fingerprints (debug + release) — extracted from
  `app-sdk/android/app/keystore` via `keytool -list -v -keystore <path> -alias <alias>`.
- iOS: AppId = `<TeamID>.com.vkoauth.appsdk`
- Scopes: `login:info`, `login:email`, `login:avatar`

## Data flow (happy path)

1. User taps button → `useYandexAuth.authorize()` → `ExpoYandexSDK.authorize()`.
2. Native module calls `YandexAuthSdk` (Android) / `YXLoginSDK.shared` (iOS) with `loginType = NATIVE` (Android) so the SDK prefers an installed Yandex app and falls back to Chrome Custom Tab when none is present.
3. SDK returns `YandexAuthResult.Success(YandexAuthToken(value, expiresIn))` → JS Promise resolves with `{ accessToken, expiresIn }`.
4. App `POST /auth/yandex/exchange { access_token }`.
5. Server `GET https://login.yandex.ru/info?format=json` with `Authorization: OAuth <token>` → user profile.
6. Server `findByProvider("yandex", id) ?? createUser(...)`.
7. Server `jwt.sign({ userId, provider, providerId }, secret, { expiresIn: "7d" })` → `{ token }`.
8. App `useAuth.login({ token })` → SecureStore → `router.replace("/home")`.

Wire-format details:
- App→server payload: `{ "access_token": "<value>" }` (snake_case to match existing VK route style).
- Server→app response: `{ "token": "<jwt>" }` (same shape as VK exchange).
- `expiresIn` from the SDK is **not** used server-side — JWT lifetime is independent.

## Error handling

### Client-side

| Where                       | Failure                                | Handling                                                 |
| --------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `ExpoYandexSDK.authorize()` | `YandexAuthResult.Cancelled`           | Resolve `{ cancelled: true }`. UI silently resets.       |
| `ExpoYandexSDK.authorize()` | `YandexAuthResult.Failure(exception)`  | Reject with native message; surface in `error` state.    |
| `useYandexAuth`             | network down before SDK launch         | Promise rejection → `setError(...)`.                     |
| `exchangeYandexToken()`     | timeout (15s `AbortController`)        | Reject → "Server unreachable".                           |
| `exchangeYandexToken()`     | non-2xx                                | Read `body.error/message`, surface to user.              |

### Server-side (`/auth/yandex/exchange`)

| Failure                                              | HTTP | Body                                                |
| ---------------------------------------------------- | ---- | --------------------------------------------------- |
| Missing `access_token`                               | 400  | `{ error: "missing_fields", message }`              |
| `login.yandex.ru/info` non-2xx (invalid/expired)     | 401  | `{ error: "yandex_token_invalid", message }`        |
| `login.yandex.ru/info` network error/timeout         | 502  | `{ error: "yandex_unreachable", message }`          |
| User upsert IO error                                 | 500  | `{ error: "user_persist_failed", message }`         |
| JWT signing error                                    | 500  | `{ error: "jwt_failed", message }`                  |

The Yandex `access_token` is treated as a one-shot proof of identity — validated once, never stored, never reused. No revocation step.

Logging: request line + `error.message` only. Never log raw `access_token`.

## Testing

### Manual (Android, local APK)

1. Backend smoke test — three curls (invalid token → 401, missing field → 400, real token → 200 + row in `users.json`).
2. APK build:
   ```
   cd app-sdk/android
   JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot" ./gradlew assembleRelease
   ```
   (`local.properties` may need recreation after `--clean prebuild`.)
3. Device tests (all three must pass):
   - **A. Yandex app installed** → tap → Yandex app opens → confirm → return to `/home`.
   - **B. No Yandex app** → Chrome Custom Tab → enter creds → return to `/home`.
   - **C. User cancels** → button re-enables, no error.
4. VK regression — VK login still works after `users.js` migration to generic schema.

### iOS

Deferred to cloud build (EAS). Wiring ships in this plan so the later iOS build succeeds without further code changes.

### Server tests

3 new Jest tests mirroring existing VK service tests:
- `exchange-yandex-success.test.js` — mock `login.yandex.ru/info` → 200 → expect JWT.
- `exchange-yandex-invalid-token.test.js` — mock 401 → expect 401.
- `exchange-yandex-missing-field.test.js` — empty body → expect 400.

No tests for the native module — Expo native modules can't be unit-tested without an emulator.

## Migration: users.json

Wipe `server/data/users.json` on first run. Test data only — no migration code. New schema applies from scratch.

## Known limitations / non-goals

- No iOS device testing in this phase.
- The community `expo-yandex-oauth` GitHub repo returns 404; we roll our own native module consistent with the existing `expo-vk-sdk` pattern.
- SHA-256 fingerprint at `oauth.yandex.com` **must** match the actual signing keystore. Mismatch → SDK silently falls back to webview (won't open the Yandex app). Document this in the registration step.
- No account-linking UI between VK and Yandex identities. A user signing in via both providers gets two separate user rows — acceptable for a test app.
