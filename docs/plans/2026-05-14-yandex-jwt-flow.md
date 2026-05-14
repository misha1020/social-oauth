# Yandex JWT Auth Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch the test app + server from sending Yandex's raw access token to sending a Yandex-signed JWT that the backend verifies offline with the app's `client_secret`.

**Architecture:** Approach B from `docs/yandex-jwt-flow-test-implementation.md` — the app fetches the JWT in JS via `login.yandex.ru/info?format=jwt`; the server adds a new `/auth/yandex/exchange-jwt` route that verifies the HS256 signature with `YANDEX_CLIENT_SECRET`, trying three key encodings. The old raw-token route stays in place as a fallback. No native module change, no `expo prebuild`.

**Tech Stack:** Node + Express 5 server (`jsonwebtoken@9`, `jest`, `supertest`), Expo React Native app (TypeScript).

**Design doc:** `docs/plans/2026-05-14-yandex-jwt-flow-design.md`

---

> **Note on commits — read this first.** This repo's owner stages and commits manually. Do **NOT** run `git add` or `git commit` anywhere in this plan. Each **Checkpoint** step is a pause point: show the diff, summarize it, and let the user review and commit. Suggested commit messages are provided for the user's convenience only.

> **Note on the secret.** `YANDEX_CLIENT_SECRET` for this test app is a 32-character hex string the user provided in chat. It goes **only** into gitignored `server/.env` — never into `.env.example`, this plan, the design doc, or any committed file.

---

### Task 1: Server config — wire in `YANDEX_CLIENT_SECRET`

**Files:**
- Modify: `server/.env` (gitignored)
- Modify: `server/.env.example`
- Modify: `server/src/index.js:35-41`

**Step 1: Add the real secret to `server/.env`**

Append one line to `server/.env`. Use the 32-char hex secret the user provided in chat:

```
YANDEX_CLIENT_SECRET=<paste the 32-char hex secret provided by the user>
```

**Step 2: Add a placeholder to `server/.env.example`**

Append to `server/.env.example` (this file IS committed — placeholder only, no real value):

```
YANDEX_CLIENT_SECRET=your_yandex_client_secret
```

**Step 3: Pass the secret into the routes**

In `server/src/index.js`, the `createAuthRoutes({...})` call is at lines 35-41. Add one line after the `yandexAppId` line:

```js
app.use('/auth', createAuthRoutes({
  jwtSecret: process.env.JWT_SECRET,
  vkAppId: process.env.VK_APP_ID,
  vkAppSecret: process.env.VK_APP_SECRET,
  yandexAppId: process.env.YANDEX_CLIENT_ID,
  yandexClientSecret: process.env.YANDEX_CLIENT_SECRET,
  usersFile,
}));
```

**Step 4: Verify the server still boots**

Run: `npm --prefix server start`
Expected: console prints `Server running on port ...` with no error. Stop it with Ctrl+C.

**Step 5: Checkpoint**

Show the diff for `server/.env.example` and `server/src/index.js` (NOT `server/.env` — it is gitignored and holds the secret). Let the user review and commit.
Suggested message: `chore(server): plumb YANDEX_CLIENT_SECRET into auth routes`

---

### Task 2: `verifyYandexJwt` helper (TDD)

**Files:**
- Create: `server/src/services/yandex.test.js`
- Modify: `server/src/services/yandex.js`

**Step 1: Ensure server dev dependencies are installed**

Run: `npm --prefix server install`
Expected: completes without error; `server/node_modules/jest` and `server/node_modules/jsonwebtoken` exist.

**Step 2: Write the failing test**

Create `server/src/services/yandex.test.js`:

```js
const jwt = require('jsonwebtoken');
const { verifyYandexJwt } = require('./yandex');

describe('verifyYandexJwt', () => {
  const secret = 'test-secret-utf8';

  test('verifies an HS256 token signed with the utf8 secret', () => {
    const token = jwt.sign({ uid: '123', first_name: 'Ann' }, secret, { algorithm: 'HS256' });
    const { claims, keyEncoding } = verifyYandexJwt(token, secret);
    expect(keyEncoding).toBe('utf8');
    expect(claims.uid).toBe('123');
    expect(claims.first_name).toBe('Ann');
  });

  test('throws yandex_jwt_invalid for a token signed with the wrong key', () => {
    const token = jwt.sign({ uid: '123' }, 'a-completely-different-secret', { algorithm: 'HS256' });
    expect(() => verifyYandexJwt(token, secret)).toThrow(/yandex_jwt_invalid/);
  });

  test('rejects an alg:none token (alg-confusion guard)', () => {
    // jsonwebtoken refuses to sign with 'none', so build the unsigned token by hand.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ uid: '123' })).toString('base64url');
    const unsignedToken = `${header}.${payload}.`;
    expect(() => verifyYandexJwt(unsignedToken, secret)).toThrow(/yandex_jwt_invalid/);
  });
});
```

**Step 3: Run the test to verify it fails**

Run: `npm --prefix server test -- src/services/yandex.test.js`
Expected: FAIL — `verifyYandexJwt is not a function` (it is not exported yet).

**Step 4: Implement `verifyYandexJwt`**

In `server/src/services/yandex.js`: add `const jwt = require('jsonwebtoken');` as the **first line** of the file, add the function below `fetchUserProfile`, and replace the final `module.exports` line.

Add at the top:

```js
const jwt = require('jsonwebtoken');
```

Add after `fetchUserProfile` (before `module.exports`):

```js
// Yandex signs the /info?format=jwt token with HS256. The key is ASSUMED to be the app's
// client_secret, but the exact byte encoding isn't documented. Try the common ones and
// report which verified — that report is one of the experiment's findings.
function verifyYandexJwt(token, clientSecret) {
  const candidates = [
    { encoding: 'utf8', key: clientSecret },
    { encoding: 'base64', key: Buffer.from(clientSecret, 'base64') },
    { encoding: 'hex', key: Buffer.from(clientSecret, 'hex') },
  ];
  const errors = [];
  for (const { encoding, key } of candidates) {
    try {
      const claims = jwt.verify(token, key, { algorithms: ['HS256'] });
      return { claims, keyEncoding: encoding };
    } catch (e) {
      errors.push(`${encoding}: ${e.message}`);
    }
  }
  throw new Error(`yandex_jwt_invalid: no key encoding verified [${errors.join(' | ')}]`);
}
```

Replace the last line:

```js
module.exports = { fetchUserProfile, verifyYandexJwt };
```

**Step 5: Run the test to verify it passes**

Run: `npm --prefix server test -- src/services/yandex.test.js`
Expected: PASS — all 3 tests green.

**Step 6: Checkpoint**

Show the diff for `server/src/services/yandex.js` and the new `server/src/services/yandex.test.js`. Let the user review and commit.
Suggested message: `feat(server): add verifyYandexJwt HS256 offline verifier with unit tests`

---

### Task 3: `/auth/yandex/exchange-jwt` route

**Files:**
- Modify: `server/src/routes/auth.js:4` (import)
- Modify: `server/src/routes/auth.js:10` (destructured params)
- Modify: `server/src/routes/auth.js` (new route, inserted after the `/yandex/exchange` route, before `/me`)

**Step 1: Update the yandex import**

`server/src/routes/auth.js` line 4 is currently:

```js
const { fetchUserProfile: fetchYandexUserProfile } = require('../services/yandex');
```

Replace with:

```js
const { fetchUserProfile: fetchYandexUserProfile, verifyYandexJwt } = require('../services/yandex');
```

**Step 2: Add `yandexClientSecret` to the route params**

Line 10 is currently:

```js
function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, usersFile }) {
```

Replace with:

```js
function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, yandexClientSecret, usersFile }) {
```

**Step 3: Add the new route**

Insert this route immediately **after** the existing `/yandex/exchange` route (after its closing `});`, around line 82) and **before** the `/me` route. Leave `/yandex/exchange` untouched.

```js
  router.post('/yandex/exchange-jwt', async (req, res) => {
    const { jwt: yandexJwt } = req.body;

    if (!yandexJwt) {
      return res.status(400).json({ error: 'missing_fields', message: 'jwt is required' });
    }
    if (!yandexClientSecret) {
      return res.status(500).json({
        error: 'server_misconfigured',
        message: 'YANDEX_CLIENT_SECRET is not set',
      });
    }

    try {
      const { claims, keyEncoding } = verifyYandexJwt(yandexJwt, yandexClientSecret);

      // These two logs ARE the experiment's result — read them in the server console.
      console.log('[yandex-jwt] VERIFIED. key encoding =', keyEncoding);
      console.log('[yandex-jwt] claims =', JSON.stringify(claims, null, 2));

      // Map claims -> the profile shape createUser expects.
      // NOTE: field names below are a best guess — Task 6 adjusts them to the logged claims.
      const profile = {
        provider: 'yandex',
        providerId: String(claims.uid),
        firstName: claims.first_name || claims.given_name || '',
        lastName: claims.last_name || claims.family_name || '',
        ...(claims.email || claims.default_email
          ? { email: claims.email || claims.default_email }
          : {}),
        ...(claims.avatar_id || claims.default_avatar_id
          ? { avatarId: claims.avatar_id || claims.default_avatar_id }
          : {}),
      };

      const user = createUser(profile, usersFile);
      const token = jwt.sign(
        { userId: user.id, provider: user.provider, providerId: user.providerId },
        jwtSecret,
        { expiresIn: '7d' }
      );

      // _debug echoed back so the result is visible on-device without the server console.
      return res.json({ token, _debug: { keyEncoding, claims } });
    } catch (err) {
      const msg = err.message || '';
      console.error('[yandex-jwt] FAILED:', msg);
      if (msg.startsWith('yandex_jwt_invalid')) {
        return res.status(401).json({ error: 'yandex_jwt_invalid', message: msg });
      }
      return res.status(500).json({ error: 'internal_error', message: msg });
    }
  });
```

(`jwt` is already required at `auth.js:2`; `createUser` is already imported at `auth.js:5` — no other imports needed.)

**Step 4: Verify the server boots and the route is registered**

Run: `npm --prefix server start`
In another terminal: `curl -X POST http://localhost:5173/auth/yandex/exchange-jwt -H "Content-Type: application/json" -d "{}"`
(Use the port from `server/.env` — `PORT`.)
Expected: HTTP 400 `{"error":"missing_fields","message":"jwt is required"}`. Stop the server with Ctrl+C.

**Step 5: Checkpoint**

Show the diff for `server/src/routes/auth.js`. Let the user review and commit.
Suggested message: `feat(server): add /auth/yandex/exchange-jwt route (offline JWT verify)`

---

### Task 4: App API client — `exchangeYandexJwt`

**Files:**
- Modify: `app-sdk/src/services/api.ts`

**Step 1: Add the new API function**

In `app-sdk/src/services/api.ts`, add this function immediately after `exchangeYandexToken` (after its closing `}`, before `getMe`). Leave `exchangeYandexToken` untouched.

```ts
export async function exchangeYandexJwt(params: {
  jwt: string;
}): Promise<{ token: string; _debug?: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(`${API_URL}/auth/yandex/exchange-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt: params.jwt }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as any).message || (body as any).error || "Yandex JWT exchange failed"
    );
  }

  return res.json();
}
```

**Step 2: Verify it type-checks**

Run: `npx --prefix app-sdk tsc --noEmit` (or the app's existing type-check command, e.g. `npm --prefix app-sdk run lint` if present).
Expected: no new TypeScript errors.

**Step 3: Checkpoint**

Show the diff for `app-sdk/src/services/api.ts`. Let the user review and commit.
Suggested message: `feat(app): add exchangeYandexJwt API client`

---

### Task 5: App hook — `useYandexAuth` fetches and sends the JWT

**Files:**
- Modify: `app-sdk/src/hooks/useYandexAuth.ts` (full replacement)

**Step 1: Replace the hook**

Replace the entire contents of `app-sdk/src/hooks/useYandexAuth.ts` with:

```ts
import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
import { exchangeYandexJwt } from "../services/api";

export interface YandexAuthResult {
  token: string;
}

// Same call the native SDK's getJwt() makes internally:
// GET login.yandex.ru/info?format=jwt&oauth_token=<token>  -> response body IS the JWT string.
async function fetchYandexJwt(accessToken: string): Promise<string> {
  const res = await fetch(
    `https://login.yandex.ru/info?format=jwt&oauth_token=${encodeURIComponent(accessToken)}`
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`yandex /info?format=jwt failed: ${res.status} ${body}`);
  }
  return body.trim();
}

export function useYandexAuth(onSuccess: (result: YandexAuthResult) => void) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const authorize = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await yandexAuthorize();
      if ("cancelled" in result && result.cancelled) {
        setIsLoading(false);
        return;
      }

      // 1. exchange the access token for a Yandex-signed JWT
      const yandexJwt = await fetchYandexJwt(result.accessToken);
      console.log("[yandex] JWT:", yandexJwt); // copy from logs to verify offline if needed

      // 2. send the JWT to our backend, which verifies the HS256 signature with client_secret
      const { token } = await exchangeYandexJwt({ jwt: yandexJwt });
      onSuccessRef.current({ token });
    } catch (err: any) {
      setError(err.message || "Yandex authentication failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authorize, isLoading, error };
}
```

**Step 2: Verify it type-checks**

Run: `npx --prefix app-sdk tsc --noEmit` (or the app's existing type-check command).
Expected: no new TypeScript errors. (`login.tsx` needs no change — it already consumes `{ authorize, isLoading, error }`.)

**Step 3: Checkpoint**

Show the diff for `app-sdk/src/hooks/useYandexAuth.ts`. Let the user review and commit.
Suggested message: `feat(app): useYandexAuth fetches Yandex JWT and sends it to the backend`

---

### Task 6: End-to-end run and claim-mapping fix

This is the experiment's real validation — no automated test substitutes for it.

**Files:**
- Modify (only if the logged claims differ from the guess): `server/src/routes/auth.js`

**Step 1: Start the server**

Run: `npm --prefix server start`
Keep the console visible.

**Step 2: Get the JS changes onto the device**

- Dev-client build installed → Metro hot-reloads the JS automatically.
- Only a release APK → rebuild the JS bundle and reinstall. **`expo prebuild` is NOT needed** — the native module is unchanged.

**Step 3: Sign in on the device**

Launch the app → tap **Sign in with Yandex** → complete the Yandex consent.

**Step 4: Read the server console — record the findings**

- `[yandex-jwt] VERIFIED. key encoding = ...` → ✅ the JWT *is* verifiable with `client_secret`. **Record which encoding** (utf8 / base64 / hex) — the real AM backend must use the same one.
- `[yandex-jwt] claims = {...}` → the real claim set. **Record it.**
- `[yandex-jwt] FAILED: yandex_jwt_invalid ...` → no encoding verified. Confirm `YANDEX_CLIENT_SECRET` is the secret for the *same* `client_id` the app authenticates under. If it is correct and still fails, JWT-only auth is not viable — stop here and report; the fallback is the raw-token + `client_id`-check flow.

**Step 5: Fix the claim → profile mapping**

Compare the logged `claims` to the `profile` mapping in the `/yandex/exchange-jwt` route. If the real claim names differ from the guess (`uid`, `first_name`, `last_name`, `email`/`default_email`, `avatar_id`/`default_avatar_id`), update the mapping in `server/src/routes/auth.js` to match. Restart the server and sign in once more to confirm the user is created with the right fields.

**Step 6: Sanity-check**

Confirm the created user (`server/data/users.json`) matches the Yandex account used to sign in — `providerId` (`uid`), `email`, name fields.

**Step 7: Checkpoint**

Show the diff for `server/src/routes/auth.js` (if the mapping changed). Let the user review and commit.
Suggested message: `fix(server): align yandex-jwt claim mapping with observed claims`

Then update the design doc / memory with the recorded findings: which key encoding verified, and the exact claim set — these are what transfers to the real AM app.

---

## Done when

- `npm --prefix server test` passes (3 `verifyYandexJwt` tests).
- Signing in with Yandex on the device produces `[yandex-jwt] VERIFIED ...` in the server console and a logged-in session.
- The recorded key encoding + claim set are written down for the real AM app.
- `/auth/yandex/exchange` and `exchangeYandexToken` still exist, untouched, as the fallback.
