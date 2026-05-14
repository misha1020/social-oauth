# Yandex JWT Auth Flow — Design (Approach B)

**Date:** 2026-05-14
**Status:** Implemented and verified on-device. The old raw access-token flow was **removed**
2026-05-14 — JWT is now the **sole** Yandex path, not one of two. See
`docs/active-task/2026-05-14-remove-yandex-access-token-flow.md`.
**Companion:** `docs/yandex-jwt-flow-test-implementation.md` (detailed implementation guide),
`docs/yandex-sdk-implementation-guide.md` (the working raw-access-token flow)

> **Superseded note (2026-05-14):** this doc was written when the plan deliberately kept both
> routes side by side. After the JWT flow verified on-device, the "keep both routes" / "fallback"
> decisions were intentionally reversed — `/yandex/exchange`, `exchangeYandexToken`, and
> `fetchUserProfile` have been deleted. Also: Approach A (native `getJwt()`), listed below as
> out-of-scope / "planned later", was implemented and verified on-device the same day — the test
> app ships it. Inline notes mark each affected spot below. Production port:
> `docs/main-app-yandex-jwt-{backend,mobile}.md`.

## Problem

The current Yandex flow sends the raw Yandex **access token** to the backend's
`/auth/yandex/exchange` route. That route calls `login.yandex.ru/info?format=json` to look the
user up — and **never checks which OAuth client the token was issued for**. A valid access
token minted for a *different* Yandex app would pass `/info` and be accepted. The access token
is also a plain bearer credential and forces a network round-trip to Yandex on every login.

## Goal

Switch the test app + server to a **JWT-based** flow: the app trades the access token for a
Yandex-signed JWT (`login.yandex.ru/info?format=jwt`), and the backend verifies that JWT's
HS256 signature **offline** with the app's `client_secret` — no Yandex call.

The security gain is precise: a JWT verified against **our** `client_secret` is
cryptographically bound to **our** `client_id`. It cannot be forged or substituted with a
token from another app, the backend needs no network round-trip, and the JWT's short `exp`
limits replay. (Caveat: the access token still exists on the device — it is used to fetch the
JWT. The hardening is specifically at the app→backend hop, which is the stated concern.)

This is **Approach B** from the companion guide: fetch the JWT in JS. No native module change,
no `expo prebuild`. Approach A (native `getJwt()`) is the eventual production shape and will be
planned separately *after* Approach B proves the `client_secret` assumption holds.

## The core unknown this proves

Yandex's docs say the `/info?format=jwt` token is "HS256, secret key" but never name the key.
This design **assumes** the key is the app's `client_secret` but does not know the byte
encoding. `verifyYandexJwt` tries the three plausible encodings (utf8 / base64 / hex) and
reports which one verified — that report *is* one of the experiment's findings.

If no encoding verifies, the JWT is signed with a key Yandex does not share with us, and
JWT-only auth is not viable — the fallback is the raw-token flow plus an explicit `client_id`
check. The old route is kept in place precisely so that fallback is a one-line hook revert.

## Flow change

```
BEFORE:  authorize() → accessToken
         → POST /yandex/exchange { access_token }
         → server: GET login.yandex.ru/info?format=json   (network call, trusts bearer token)
         → createUser → sign app JWT

AFTER:   authorize() → accessToken
         → app: GET login.yandex.ru/info?format=jwt        (app trades token for a JWT)
         → POST /yandex/exchange-jwt { jwt }
         → server: jwt.verify(jwt, YANDEX_CLIENT_SECRET, HS256)   (offline, no Yandex call)
         → createUser → sign app JWT
```

## Scope decisions

- **Approach B only.** ~~Approach A (native Kotlin `getJwt()` + APK rebuild) is out of scope;
  planned later, once B confirms verification works.~~ *(Superseded 2026-05-14: Approach A was
  implemented and verified on-device right after B confirmed. The test app ships Approach A.)*
- ~~**Keep both routes.**~~ *(Superseded 2026-05-14: `/yandex/exchange` + `exchangeYandexToken`
  were kept during the spike for A/B comparison and one-line rollback, then **removed** once the
  JWT flow verified on-device. JWT is the only Yandex path now.)*
- **Include a unit test** for `verifyYandexJwt` (it is a pure function).
- **Keep the `_debug` echo** in the route response — this is a test app, and echoing
  `{ keyEncoding, claims }` lets the result be read on-device. It would be stripped before any
  production use.

## Components

### Server

| File | Change |
|---|---|
| `server/.env` | Add `YANDEX_CLIENT_SECRET=…` — **gitignored, never committed**. Must be the secret for the *same* `client_id` the test app authenticates under. |
| `server/.env.example` | Add `YANDEX_CLIENT_SECRET=your_yandex_client_secret` — placeholder only (committed). |
| `server/src/index.js` | Pass `yandexClientSecret: process.env.YANDEX_CLIENT_SECRET` into the `createAuthRoutes({…})` call. |
| `server/src/services/yandex.js` | Add and export `verifyYandexJwt(token, clientSecret)`. Tries utf8 / base64 / hex HS256 keys; returns `{ claims, keyEncoding }`; throws `yandex_jwt_invalid: …` listing each encoding's failure. Keep `fetchUserProfile` exported. |
| `server/src/routes/auth.js` | Import `verifyYandexJwt`; add `yandexClientSecret` to the destructured `createAuthRoutes` params; add `POST /yandex/exchange-jwt`. Leave `/yandex/exchange` untouched. |
| `server/src/services/yandex.test.js` (new) | Jest unit test for `verifyYandexJwt`. |

The `/yandex/exchange-jwt` route:
1. 400 `missing_fields` if `jwt` absent; 500 `server_misconfigured` if `YANDEX_CLIENT_SECRET` unset.
2. `verifyYandexJwt(jwt, yandexClientSecret)` → `{ claims, keyEncoding }`.
3. `console.log` the `keyEncoding` and `claims` — **this console output is the experiment's result.**
4. Map `claims` → the profile shape `createUser` expects. **The field mapping is a best
   guess** (`uid`, `first_name` vs `given_name`, `email` vs `default_email`, …) until the
   first live run logs the real claim set.
5. `createUser(profile, usersFile)`, then sign the app's own 7-day JWT with `jwtSecret`.
6. Return `{ token, _debug: { keyEncoding, claims } }`.
7. On `yandex_jwt_invalid` → 401; otherwise → 500.

### App

| File | Change |
|---|---|
| `app-sdk/src/services/api.ts` | Add `exchangeYandexJwt({ jwt })` next to `exchangeYandexToken` (kept). POSTs `{ jwt }` to `/auth/yandex/exchange-jwt`, 15s timeout, returns `{ token, _debug? }`. |
| `app-sdk/src/hooks/useYandexAuth.ts` | Add `fetchYandexJwt(accessToken)` helper — `GET login.yandex.ru/info?format=jwt&oauth_token=…`, read response with `res.text()` (the body *is* the JWT string). Hook flow becomes `authorize()` → `fetchYandexJwt` → `exchangeYandexJwt`. Log the JWT for offline inspection. |

`app-sdk/.../login.tsx` is unchanged — it already consumes `{ authorize, isLoading, error }`.
No native module change, no `expo prebuild`.

## Error handling

- Missing `jwt` in request body → **400** `missing_fields`
- `YANDEX_CLIENT_SECRET` unset on the server → **500** `server_misconfigured`
- No key encoding verifies the signature → **401** `yandex_jwt_invalid`, message lists each
  encoding's failure reason
- `/info?format=jwt` returns non-200 → hook throws with status + response body
- ~~The old `/yandex/exchange` route and `exchangeYandexToken` remain as a working fallback~~
  *(Superseded 2026-05-14: both were removed — there is no longer a fallback path.)*

## Testing

### Unit test — `verifyYandexJwt` (jest, already in devDependencies)

- Sign a token with a known secret (utf8 key) → assert `verifyYandexJwt` returns
  `keyEncoding: 'utf8'` and the expected claims.
- Sign with a wrong key → assert it throws `yandex_jwt_invalid`.
- Attempt alg-confusion (a token with `alg: RS256` or `none`) → assert rejected.

### Manual end-to-end — the real validation

1. Start the server (`cd server && npm start`), watch the console.
2. Launch the app, tap **Sign in with Yandex**, complete the Yandex consent.
3. Read the server console:
   - `[yandex-jwt] VERIFIED. key encoding = …` → the assumption holds; **note the encoding**.
   - `[yandex-jwt] claims = {…}` → the real claim set.
   - `[yandex-jwt] FAILED: yandex_jwt_invalid …` → no encoding verified; double-check the
     secret is for the same `client_id`; if still failing, JWT-only auth is not viable.
4. **Adjust the claim→profile mapping** in `/yandex/exchange-jwt` to the actual claim names.
5. Sanity-check the claims match the Yandex account used to sign in (`uid`, `email`).

## Out of scope

- ~~Approach A (native `getJwt()` in Kotlin, types update, APK rebuild) — separate later plan.~~
  *(Superseded 2026-05-14: Approach A was implemented and verified on-device. As-built code is
  in `docs/main-app-yandex-jwt-mobile.md §2`.)*
- ~~Removing the old `/yandex/exchange` route — kept deliberately as fallback / A-B comparison.~~
  *(Superseded 2026-05-14: it **was** removed — see
  `docs/active-task/2026-05-14-remove-yandex-access-token-flow.md`.)*
- Any change to the VK flow.
- Carrying findings into the real AM app — this test app uses its own Yandex
  `client_id`/`client_secret`; findings transfer in *shape* (does verification work, which
  encoding, which claims), not in literal values.

## Findings — live run 2026-05-14

The spike's core unknowns are resolved. A live Yandex login through the release APK produced
`[yandex-jwt] VERIFIED` on the server.

**Key encoding: `utf8`.** The `/info?format=jwt` token is HS256-signed with the app's
`client_secret` used **directly as a UTF-8 string** — not base64- or hex-decoded. The real AM
backend must use the same: `jwt.verify(token, clientSecret, { algorithms: ['HS256'] })`.

**Claim set** (12 claims; values are this test account's and are not recorded here):

| Claim | Notes |
|---|---|
| `uid` | numeric user id → `providerId` |
| `login` | Yandex login handle |
| `name` | **full** name in one string — there is **no** `first_name`/`last_name` pair |
| `display_name` | short display form (e.g. "Имя Ф.") |
| `email` | primary email — claim is `email`, **not** `default_email` |
| `avatar_id` | avatar id — claim is `avatar_id`, **not** `default_avatar_id` |
| `gender` | e.g. `male` |
| `psuid` | per-service user id |
| `iss` | `login.yandex.ru` |
| `iat` / `exp` / `jti` | standard JWT registered claims; `exp` is long-lived |

**Mapping consequence:** the `/yandex/exchange-jwt` route splits `name` on whitespace into
`firstName` / `lastName` (the JWT carries no separate name parts), and reads `email` /
`avatar_id` directly. `iss` is `login.yandex.ru` and could be asserted as an extra guard.
