# Active Task: Remove the Yandex access-token flow — commit fully to JWT

**Created:** 2026-05-14
**Status:** Ready to execute in a new session
**Suggested skill:** `superpowers:executing-plans`
**Companion:** `docs/plans/2026-05-14-yandex-jwt-flow-design.md` (the JWT flow this builds on)

---

## Goal

The Yandex JWT flow (`POST /auth/yandex/exchange-jwt`) is implemented and **verified end-to-end
on a real device** (2026-05-14: the JWT verifies with `client_secret` used as a UTF-8 HS256
key). We are now committing to it as the **only** Yandex path. This task **removes the old raw
access-token flow** that was deliberately kept as a fallback during the spike.

## Prerequisite state — read before starting

- The JWT flow ("Tasks 1–6" of `docs/plans/2026-05-14-yandex-jwt-flow-plan.md`) is implemented
  and verified but **NOT yet committed** — it is sitting uncommitted in the working tree
  (`server/.env.example`, `server/src/index.js`, `server/src/routes/auth.js`,
  `server/src/services/yandex.js`, new `server/src/services/yandex.test.js`,
  `app-sdk/src/services/api.ts`, `app-sdk/src/hooks/useYandexAuth.ts`,
  `docs/plans/2026-05-14-yandex-jwt-flow-design.md`).
- **Recommendation:** commit the JWT-flow work **first**, as its own commit(s), *then* do this
  removal as a **separate** commit. Don't entangle "add JWT flow" and "remove old flow" in one
  diff — the history reads far better split.
- **Commit policy (repo convention):** the owner stages and commits manually. Do **NOT** run
  `git add` / `git commit`. Stop at each checkpoint and let the owner review + commit.

---

## What is being removed (the access-token flow)

| File | Change |
|---|---|
| `server/src/routes/auth.js` | Delete the `POST /yandex/exchange` route (lines **51–82**). Drop `fetchUserProfile: fetchYandexUserProfile` from the yandex `require` on line **4**. |
| `server/src/services/yandex.js` | Delete `fetchUserProfile` (lines **3–32**). Change the export (line **55**) to `module.exports = { verifyYandexJwt };`. |
| `server/tests/services/yandex.test.js` | **Delete the whole file** — it tests only `fetchUserProfile` (4 tests). |
| `server/tests/routes/auth.yandex.test.js` | **Delete the whole file** — it tests only `POST /auth/yandex/exchange` (6 tests). |
| `app-sdk/src/services/api.ts` | Delete `exchangeYandexToken` (lines **50–71**). `useYandexAuth` already imports only `exchangeYandexJwt`, so nothing breaks. |

## What stays (do NOT touch)

- `POST /auth/yandex/exchange-jwt` route, `verifyYandexJwt`, and `server/src/services/yandex.test.js` (the JWT unit test added during the spike).
- `exchangeYandexJwt` in `api.ts`; `useYandexAuth.ts` (already JWT-only).
- The entire VK flow — `exchangeCode`, the VK `fetchUserProfile`, `POST /vk/exchange`, all VK tests. `fetchVKUserProfile` is still used by the VK route.

---

## Task 1: Server — remove the route, the service function, and the dead tests

**Steps:**
1. `server/src/routes/auth.js` — delete the `POST /yandex/exchange` route handler (lines 51–82) and the trailing blank line. Update line 4 to `const { verifyYandexJwt } = require('../services/yandex');`.
2. `server/src/services/yandex.js` — delete `fetchUserProfile` (lines 3–32). Update the export to `module.exports = { verifyYandexJwt };`. Keep `const jwt = require('jsonwebtoken');` and `verifyYandexJwt`.
3. Delete `server/tests/services/yandex.test.js` and `server/tests/routes/auth.yandex.test.js`.
4. Review the stale comment at `auth.js:8-9` ("token validation uses the bearer token alone") — it described the old flow. Note: `yandexAppId` is now an entirely unused `createAuthRoutes` param (it was already effectively dead). Optional: drop `yandexAppId` from the destructure here and from the call site in `server/src/index.js`, and fix the comment.
5. **Verify:** `cd server && npm test` passes. `cd server && npm start` boots clean; `curl -X POST .../auth/yandex/exchange` now returns **404**; `curl -X POST .../auth/yandex/exchange-jwt -d "{}"` still returns **400 missing_fields**.

**Decision point — route-level test coverage:** deleting `auth.yandex.test.js` leaves the
Yandex *route* with zero route-level tests (only `verifyYandexJwt` has a unit test).
**Recommended:** write a replacement `server/tests/routes/auth.yandex-jwt.test.js` — mock
`verifyYandexJwt`, pass `yandexClientSecret` into `createAuthRoutes`, cover the 400 / 500
`server_misconfigured` / 401 `yandex_jwt_invalid` / 200 paths. (TDD: if you do this, write it
before/with the deletions.)

**Checkpoint:** owner reviews + commits the server removal.

## Task 2: App — remove `exchangeYandexToken`

**Steps:**
1. `app-sdk/src/services/api.ts` — delete `exchangeYandexToken` (lines 50–71) and the trailing blank line. Leave `exchangeYandexJwt` and everything else.
2. **Verify:** `cd app-sdk && npx tsc --noEmit` is clean.

**Checkpoint:** owner reviews + commits the app removal.

## Task 3: Docs + memory — retire the "fallback" language

The old flow was documented as a deliberately-kept fallback. After removal that is false.

**Steps:**
1. `docs/plans/2026-05-14-yandex-jwt-flow-design.md` — these now contradict reality and need a status note or edit:
   - "Scope decisions → **Keep both routes**"
   - "Error handling → *The old `/yandex/exchange` route … remain as a working fallback*"
   - "Out of scope → *Removing the old `/yandex/exchange` route — kept deliberately as fallback*"
2. Memory: `MEMORY.md` + `project_social_oauth_status.md` — the line stating the old route +
   `exchangeYandexToken` are "kept untouched as the fallback" is now wrong; update it to say the
   access-token flow was removed and JWT is the sole Yandex path.
3. Historical plan docs (`docs/plans/2026-05-14-yandex-jwt-flow.md`, `-plan.md`,
   `docs/yandex-jwt-flow-test-implementation.md`) are execution **records** — leave their bodies
   as-is; at most add a one-line forward-pointer. Do not rewrite history.
4. Optional cleanup: with `server/tests/services/yandex.test.js` now deleted, consider moving
   the spike's `server/src/services/yandex.test.js` → `server/tests/services/yandex.test.js` so
   it matches the repo's `tests/` convention (the spike co-located it in `src/`, inconsistently).

**Checkpoint:** owner reviews + commits the doc updates.

---

## Done when

- `cd server && npm test` passes — expect ~23 tests / 5 suites if the old test files are simply
  deleted; more if the recommended `auth.yandex-jwt.test.js` replacement is added.
- `cd app-sdk && npx tsc --noEmit` is clean.
- No references to the removed symbols remain in source: `grep -rn "fetchYandexUserProfile\|exchangeYandexToken\|/yandex/exchange'" server/src app-sdk/src` returns nothing (the VK `fetchUserProfile` is unrelated and stays).
- Server boots; `POST /auth/yandex/exchange` → 404; `POST /auth/yandex/exchange-jwt` → still works.
- Design doc + memory no longer describe the access-token flow as a live fallback.

---

## Related follow-ups — NOT in this task's scope (separate decision)

From the 2026-05-14 security review of the JWT flow. Removing the fallback makes the JWT path
the *only* path, so its weaknesses matter more — but these are independent of the removal and
should be planned separately:

- The Yandex JWT `exp` is **~1 year** out (observed `exp` ≈ 2027-05) — not "short" as the
  design doc's Goal assumed. A stolen JWT is replayable against the backend for ~12 months.
- `API_URL` is **cleartext HTTP** (`http://192.168.87.125:5173` + `withCleartextHttp` plugin) —
  the JWT is sniffable on the LAN.
- Candidate mitigations: serve over **HTTPS**; **one-time-use `jti`** tracking in
  `/exchange-jwt` (the claim set includes `jti`); assert `iss === "login.yandex.ru"`; strip the
  `_debug` echo and the JWT `console.log`s before any production use.
