# Yandex JWT Auth Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Commit policy for this repo:** The repo owner stages and commits manually. Do **not** run
> `git add` or `git commit`. Every "Checkpoint" below is where the owner reviews and commits —
> stop there and let them.

**Goal:** Switch the test app's Yandex login from sending the raw access token to the backend
to sending a Yandex-signed JWT that the backend verifies offline with `client_secret` (HS256).

**Architecture:** Approach B — the app trades the access token for a JWT via
`login.yandex.ru/info?format=jwt` in JS (no native module change), POSTs the JWT to a new
`/auth/yandex/exchange-jwt` route, and the server verifies the HS256 signature with the app's
`client_secret`. The exact key byte-encoding is unknown, so the verifier tries utf8 / base64 /
hex and reports which one worked. The old raw-token route stays in place as a fallback.

**Tech Stack:** Node/Express server (`jsonwebtoken@9`, jest + supertest), Expo React Native
app (TypeScript), no native changes.

**Design doc:** `docs/plans/2026-05-14-yandex-jwt-flow-design.md`

---

## Task 1: Server config — plumb `YANDEX_CLIENT_SECRET`

**Files:**
- Modify: `server/.env` (gitignored — holds the real secret)
- Modify: `server/.env.example` (committed — placeholder only)
- Modify: `server/src/index.js:35-41`

**Step 1: Add the real secret to `server/.env`**

Append this line to `server/.env` (the value is the test app's Yandex client secret — a
32-char hex string, provided separately, **not written into this committed plan**):

```
YANDEX_CLIENT_SECRET=<test app's Yandex client secret>
```

**Step 2: Add a placeholder to `server/.env.example`**

Append to `server/.env.example`:

```
YANDEX_CLIENT_SECRET=your_yandex_client_secret
```

**Step 3: Pass it into the routes**

In `server/src/index.js`, the `createAuthRoutes({...})` call (lines 35-41) — add the
`yandexClientSecret` line:

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

**Step 4: Verify deps are installed**

Run (in `server/`): `npm install`
Expected: completes without error; `node_modules/jsonwebtoken` and `node_modules/jest` exist.

**Step 5: Checkpoint** — owner reviews and commits (`server/.env.example`, `server/src/index.js`;
`server/.env` stays uncommitted).

---

## Task 2: Server — `verifyYandexJwt` helper (TDD)

**Files:**
- Create: `server/src/services/yandex.test.js`
- Modify: `server/src/services/yandex.js`

**Step 1: Write the failing test**

Create `server/src/services/yandex.test.js`:

```js
const jwt = require('jsonwebtoken');
const { verifyYandexJwt } = require('./yandex');

// 32-char hex string — the shape Yandex uses for client secrets.
const SECRET = '6534fcc4a8ce4b92807d1743c377cd5c';
const CLAIMS = { uid: '12345', first_name: 'Test', last_name: 'User' };

describe('verifyYandexJwt', () => {
  test('verifies a token signed with the utf8 secret string', () => {
    const token = jwt.sign(CLAIMS, SECRET, { algorithm: 'HS256' });
    const result = verifyYandexJwt(token, SECRET);
    expect(result.keyEncoding).toBe('utf8');
    expect(result.claims.uid).toBe('12345');
  });

  test('verifies a token signed with the base64-decoded secret', () => {
    const token = jwt.sign(CLAIMS, Buffer.from(SECRET, 'base64'), { algorithm: 'HS256' });
    expect(verifyYandexJwt(token, SECRET).keyEncoding).toBe('base64');
  });

  test('verifies a token signed with the hex-decoded secret', () => {
    const token = jwt.sign(CLAIMS, Buffer.from(SECRET, 'hex'), { algorithm: 'HS256' });
    expect(verifyYandexJwt(token, SECRET).keyEncoding).toBe('hex');
  });

  test('throws yandex_jwt_invalid for a token signed with a different key', () => {
    const token = jwt.sign(CLAIMS, 'a-totally-different-secret', { algorithm: 'HS256' });
    expect(() => verifyYandexJwt(token, SECRET)).toThrow(/yandex_jwt_invalid/);
  });

  test('rejects an alg-confusion token (alg: none)', () => {
    const token = jwt.sign(CLAIMS, null, { algorithm: 'none' });
    expect(() => verifyYandexJwt(token, SECRET)).toThrow(/yandex_jwt_invalid/);
  });
});
```

**Step 2: Run the test to verify it fails**

Run (in `server/`): `npx jest src/services/yandex.test.js`
Expected: FAIL — `verifyYandexJwt is not a function` (not yet exported).

**Step 3: Write the minimal implementation**

In `server/src/services/yandex.js`, add `const jwt = require('jsonwebtoken');` as the first
line, then add this function above `module.exports`:

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

Change the export line from `module.exports = { fetchUserProfile };` to:

```js
module.exports = { fetchUserProfile, verifyYandexJwt };
```

**Step 4: Run the test to verify it passes**

Run (in `server/`): `npx jest src/services/yandex.test.js`
Expected: PASS — 5 passed.

**Step 5: Checkpoint** — owner reviews and commits (`server/src/services/yandex.js`,
`server/src/services/yandex.test.js`).

---

## Task 3: Server — `/yandex/exchange-jwt` route

**Files:**
- Modify: `server/src/routes/auth.js:4` (import)
- Modify: `server/src/routes/auth.js:10` (params)
- Modify: `server/src/routes/auth.js` (add route after the `/yandex/exchange` route, ~line 82)

**Step 1: Add `verifyYandexJwt` to the yandex import**

Change line 4 of `server/src/routes/auth.js` from:

```js
const { fetchUserProfile: fetchYandexUserProfile } = require('../services/yandex');
```

to:

```js
const { fetchUserProfile: fetchYandexUserProfile, verifyYandexJwt } = require('../services/yandex');
```

**Step 2: Add `yandexClientSecret` to the destructured params**

Change line 10 from:

```js
function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, usersFile }) {
```

to:

```js
function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, yandexClientSecret, usersFile }) {
```

**Step 3: Add the route**

In `server/src/routes/auth.js`, immediately after the existing `/yandex/exchange` route's
closing `});` (around line 82) and before `router.get('/me', ...)`, insert:

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
      // NOTE: field names below are a best guess — Task 6 corrects them from the logged claims.
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

(`jwt` is already required at the top of `auth.js:2`; `createUser` is already imported at
`auth.js:5` — no other imports needed.)

**Step 4: Smoke-test the route wiring**

Run (in `server/`): `npm start`
Expected: `Server running on port <PORT>`, no startup error.

In a second terminal, send a deliberately bad JWT:

```bash
curl -s -X POST http://localhost:<PORT>/auth/yandex/exchange-jwt \
  -H "Content-Type: application/json" -d "{\"jwt\":\"not-a-real-jwt\"}"
```

Expected: HTTP 401 JSON `{"error":"yandex_jwt_invalid", ...}` — confirms the route is mounted,
`YANDEX_CLIENT_SECRET` is loaded, and `verifyYandexJwt` runs. Stop the server.

(Also confirm missing-body handling: `-d "{}"` → HTTP 400 `missing_fields`.)

**Step 5: Checkpoint** — owner reviews and commits (`server/src/routes/auth.js`).

---

## Task 4: App — `exchangeYandexJwt` API call

**Files:**
- Modify: `app-sdk/src/services/api.ts` (add after `exchangeYandexToken`, ~line 71)

**Step 1: Add the function**

In `app-sdk/src/services/api.ts`, after the `exchangeYandexToken` function (it ends at line
71) and before `getMe`, insert:

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

`exchangeYandexToken` stays untouched (kept as fallback).

**Step 2: Type-check**

Run (in `app-sdk/`): `npx tsc --noEmit`
Expected: no new errors from `api.ts`.

**Step 3: Checkpoint** — owner reviews and commits (`app-sdk/src/services/api.ts`).

---

## Task 5: App — `useYandexAuth` fetches the JWT

**Files:**
- Modify: `app-sdk/src/hooks/useYandexAuth.ts` (replace whole file)

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

`login.tsx` needs no change — it already consumes `{ authorize, isLoading, error }`.

**Step 2: Type-check**

Run (in `app-sdk/`): `npx tsc --noEmit`
Expected: no new errors.

**Step 3: Checkpoint** — owner reviews and commits (`app-sdk/src/hooks/useYandexAuth.ts`).

---

## Task 6: End-to-end test + correct the claim mapping

This task has no code written up front — it runs the flow against live Yandex and fixes the
claim→profile mapping based on what the JWT actually carries.

**Files (likely modified after the run):**
- Modify: `server/src/routes/auth.js` — the `profile` object inside `/yandex/exchange-jwt`

**Step 1: Run the flow**

1. Start the server: `cd server && npm start`. Watch the console.
2. Get the JS changes onto the device: with a dev-client build, Metro hot-reloads instantly;
   with only a release APK, rebuild the JS bundle (no `expo prebuild` — native is unchanged).
3. Launch the app, tap **Sign in with Yandex**, complete the Yandex consent.

**Step 2: Read the server console — this is the experiment result**

- `[yandex-jwt] VERIFIED. key encoding = utf8` (or `base64` / `hex`) → the JWT *is* signed
  with our `client_secret`. **Record which encoding** — the real AM backend must use the same.
- `[yandex-jwt] claims = {...}` → the exact claim set.
- `[yandex-jwt] FAILED: yandex_jwt_invalid ...` → no encoding verified. Re-check that
  `YANDEX_CLIENT_SECRET` is the secret for the *same* `client_id` the app authenticates under.
  If it is correct and still fails, JWT-only auth is not viable — stop here and report; the
  fallback is the kept raw-token route plus an explicit `client_id` check.

**Step 3: Correct the claim mapping**

Compare the logged `claims` against the `profile` object in `/yandex/exchange-jwt`
(`server/src/routes/auth.js`). Adjust the field names to the actual claims — confirm `uid`
exists and is the user id; pick the real email and name field names; drop branches for fields
that aren't present.

**Step 4: Re-run and sanity-check**

Repeat Step 1 with a fresh login (the JWT `exp` is short). Confirm the app navigates to the
home screen and the created user in `server/data/users.json` matches the Yandex account used
(`providerId`, `email`, name).

**Step 5: Checkpoint** — owner reviews and commits (`server/src/routes/auth.js` with the
corrected mapping). Record the verified key encoding and claim set in the design doc or a
short findings note for the real AM app.

---

## Done when

- `npx jest src/services/yandex.test.js` passes (5 tests).
- A live Yandex login through the app produces `[yandex-jwt] VERIFIED` in the server console
  and navigates to the home screen.
- The verified key encoding and the real claim set are recorded.
- The old `/yandex/exchange` route and `exchangeYandexToken` are still present and untouched.
