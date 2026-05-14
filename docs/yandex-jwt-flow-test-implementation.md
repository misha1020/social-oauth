# Yandex JWT Flow — Test App Implementation Guide

**Audience:** You (Mukhtar), changing the `social-oauth` test app to try the JWT-based Yandex
auth flow yourself before committing to it in the real AM app.

**Companion to:** `yandex-sdk-implementation-guide.md` (the working raw-access-token flow).

> **Status (2026-05-14): spike complete — both approaches implemented and verified on-device.**
> - **Approach B** (JS-side JWT fetch) — verified first, then hardened to send the access token
>   in the `Authorization: OAuth` header instead of the `?oauth_token=` query param.
> - **Approach A** (native `getJwt()`) — implemented in the Kotlin module and verified
>   on-device immediately after; it produces a JWT that verifies identically. **The test app
>   now ships Approach A.**
> - The old raw **access-token** flow (`/auth/yandex/exchange`, `exchangeYandexToken`,
>   `fetchUserProfile`) has since been **removed** — JWT is the sole Yandex path. The
>   "keep both flows" notes further down are historical (see
>   `docs/active-task/2026-05-14-remove-yandex-access-token-flow.md`).
> - **Production port specs:** `docs/main-app-yandex-jwt-backend.md` +
>   `docs/main-app-yandex-jwt-mobile.md`.

## What this tests, and why

Today the test app sends the raw Yandex **access token** to the backend, which calls
`login.yandex.ru/info` to look the user up. The proposed change sends a Yandex **JWT** instead,
and the backend verifies the JWT's HS256 signature **offline** with the app's `client_secret` —
no `/info` call.

The whole exercise hinges on **one unknown**: *is the Yandex JWT actually signed with our
`client_secret`?* Yandex's docs say "HS256, secret key" but never name the key. This guide
makes the test app prove it end-to-end. After it works you'll know:

1. Whether `verify(jwt, client_secret, HS256)` succeeds at all.
2. Which key encoding Yandex expects (raw string / base64 / hex).
3. Exactly what claims the JWT carries (so the real backend knows what it can read).

## Current flow vs target flow

```
CURRENT (raw access token):
  native authorize() -> { accessToken }
  -> POST /auth/yandex/exchange { access_token }
  -> server: GET login.yandex.ru/info?format=json  (Authorization: OAuth <token>)
  -> server: create user, sign own JWT

TARGET (Yandex JWT):
  native authorize() -> { accessToken }
  -> GET login.yandex.ru/info?format=jwt&oauth_token=<accessToken>   (returns the JWT)
  -> POST /auth/yandex/exchange-jwt { jwt }
  -> server: jwt.verify(jwt, YANDEX_CLIENT_SECRET, HS256)   (offline, no Yandex call)
  -> server: create user from claims, sign own JWT
```

## Two approaches — start with Approach B

- **Approach B — fetch the JWT in JS.** Keep the native module as-is; in the hook, call
  `login.yandex.ru/info?format=jwt` with the access token to get the JWT. This is the *exact*
  same call the SDK's native `getJwt()` makes internally, so it produces an identical JWT — but
  needs **no Kotlin change and no prebuild**. Use this to test the flow.
- **Approach A — native `getJwt()`.** Modify the Kotlin module to call
  `YandexAuthSdk.getJwt(token)` and return the JWT. This is the production-shape path. Do this
  *after* Approach B confirms the backend can verify the JWT — it requires an APK rebuild.

Both produce the same JWT and hit the same backend endpoint. Approach B just iterates faster.

---

# Approach B — JS-side JWT fetch (recommended first)

Touches: `server/.env`, `server/.env.example`, `server/src/index.js`,
`server/src/services/yandex.js`, `server/src/routes/auth.js`, `app-sdk/src/services/api.ts`,
`app-sdk/src/hooks/useYandexAuth.ts`. **No native module change, no `expo prebuild`.**

## B1 — server: add `YANDEX_CLIENT_SECRET`

Get the secret from https://oauth.yandex.com -> your **test app's** Yandex client -> it's the
client password / "Пароль приложения". ⚠ It must be the secret for the **same client_id the
test app authenticates under** — the JWT is (hypothetically) signed with that client's secret,
so verifying with a different client's secret will always fail.

Add to `server/.env`:

```
YANDEX_CLIENT_SECRET=<paste the test app's Yandex client secret>
```

Add to `server/.env.example` (no real value — it's committed):

```
YANDEX_CLIENT_SECRET=your_yandex_client_secret
```

## B2 — server: pass it into the routes

In `server/src/index.js`, the `createAuthRoutes({...})` call — add one line:

```js
app.use('/auth', createAuthRoutes({
  jwtSecret: process.env.JWT_SECRET,
  vkAppId: process.env.VK_APP_ID,
  vkAppSecret: process.env.VK_APP_SECRET,
  yandexAppId: process.env.YANDEX_CLIENT_ID,
  yandexClientSecret: process.env.YANDEX_CLIENT_SECRET,   // <-- add
  usersFile,
}));
```

## B3 — server: add a JWT-verify helper

In `server/src/services/yandex.js`, add this function and export it. It tries the three
plausible key encodings and reports which one worked — that *is* one of the test findings:

```js
const jwt = require('jsonwebtoken');

// Yandex signs the /info?format=jwt token with HS256. The key is ASSUMED to be the app's
// client_secret, but the exact byte encoding isn't documented. Try the common ones.
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

module.exports = { fetchUserProfile, verifyYandexJwt };  // keep fetchUserProfile in the exports
```

## B4 — server: add the `/yandex/exchange-jwt` route

In `server/src/routes/auth.js`:

1. Import the helper at the top, next to the existing yandex import:

```js
const { fetchUserProfile: fetchYandexUserProfile, verifyYandexJwt } = require('../services/yandex');
```

2. Add `yandexClientSecret` to the `createAuthRoutes({...})` destructured params.

3. Add this route (next to the existing `/yandex/exchange` route — keep that one too, so you
   can compare both flows):

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

    // These two logs ARE the test result — read them in the server console.
    console.log('[yandex-jwt] VERIFIED. key encoding =', keyEncoding);
    console.log('[yandex-jwt] claims =', JSON.stringify(claims, null, 2));

    // Map claims -> the profile shape createUser expects.
    // NOTE: field names below are a best guess — check the logged claims and adjust.
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

    // _debug echoed back so you can also see the result on the device without the server console.
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

(`jwt` is already required at the top of `auth.js`, and `createUser` is already imported —
no extra imports beyond `verifyYandexJwt`.)

## B5 — app: add the API call

In `app-sdk/src/services/api.ts`, add next to `exchangeYandexToken`:

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

## B6 — app: fetch the JWT in the hook and send it

Replace `app-sdk/src/hooks/useYandexAuth.ts` with:

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
      console.log("[yandex] JWT:", yandexJwt); // copy this from logs if you want to verify it offline too

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

## B7 — getting the JS changes onto the device

Approach B changes **only JS + server**:
- **Server** — restart it (`npm start` in `server/`). It now serves `/auth/yandex/exchange-jwt`.
- **App** — if you have a **dev-client build** installed, Metro hot-reloads the JS instantly.
  If you only have the **release APK**, rebuild it to pick up the new JS bundle — but you do
  **not** need `expo prebuild` (the native module is unchanged), just the JS build step.

---

# Approach A — native `getJwt()` (production shape)

> **✅ Implemented and verified on-device 2026-05-14.** A1–A4 below are the spike write-up. The
> shipped Kotlin replaced the silent `?: ""` JWT fallback in A1 with an explicit null-check that
> rejects honestly — see the as-built code in `docs/main-app-yandex-jwt-mobile.md §2`.

This is what the real AM app will ship. It requires a Kotlin change + APK rebuild.

## A1 — Kotlin: call `getJwt` off-thread

In `app-sdk/modules/expo-yandex-sdk/android/src/main/java/expo/modules/yandexsdk/ExpoYandexSDKModule.kt`,
replace the `YandexAuthResult.Success` branch inside `ensureLauncher`:

```kotlin
is YandexAuthResult.Success -> {
    val token = result.token
    // getJwt is a blocking @WorkerThread call — must NOT run on the result-callback thread.
    Thread {
        try {
            val jwt = sdk?.getJwt(token) ?: ""
            resolvePending(
                mapOf(
                    "accessToken" to token.value,
                    "expiresIn" to token.expiresIn,
                    "jwt" to jwt
                )
            )
        } catch (e: Exception) {
            rejectPending("getJwt failed: ${e.message}")
        }
    }.start()
}
```

(If `sdk?.getJwt(token)` doesn't resolve, check the SDK's API surface — the method may be on
the `YandexAuthSdk` instance as shown, or named slightly differently in 3.2.0. Inspect the AAR
per the implementation guide's section 11 if needed.)

## A2 — types: add the `jwt` field

In `app-sdk/modules/expo-yandex-sdk/src/ExpoYandexSDK.types.ts`:

```ts
export type YandexAuthSuccess = {
  cancelled?: false;
  accessToken: string;
  expiresIn: number;
  jwt: string;        // <-- add
};
```

## A3 — hook: use `result.jwt` directly

In `useYandexAuth.ts`, drop the `fetchYandexJwt` helper and use the native value:

```ts
const result = await yandexAuthorize();
if ("cancelled" in result && result.cancelled) { setIsLoading(false); return; }

const { token } = await exchangeYandexJwt({ jwt: result.jwt });
onSuccessRef.current({ token });
```

## A4 — rebuild

Native module changed, so: `npx expo prebuild --clean --no-install`, recreate
`android/local.properties`, then `gradlew assembleRelease` and reinstall (implementation guide
section 8).

---

# Running the test

1. Start the server (`cd server && npm start`). Watch its console.
2. Launch the app, tap **Sign in with Yandex**, complete the Yandex consent.
3. Read the server console:
   - **`[yandex-jwt] VERIFIED. key encoding = utf8`** (or base64/hex) -> ✅ the JWT *is*
     signed with our `client_secret`. The whole JWT design is viable. Note which encoding —
     the real backend must use the same one.
   - **`[yandex-jwt] claims = {...}`** -> the exact claim set. Confirm `uid` is present and
     the email/name fields — adjust the `profile` mapping in B4 to match what's really there.
   - **`[yandex-jwt] FAILED: yandex_jwt_invalid ...`** -> none of the three key encodings
     verified. Double-check `YANDEX_CLIENT_SECRET` is the secret for the *same* client_id the
     app authenticates under. If it's definitely correct and still fails, the JWT is signed
     with a key Yandex doesn't share with us — and JWT-only auth is not viable; fall back to
     the raw-token + `/info` `client_id`-check flow.
4. Sanity-check the claims match the Yandex account you logged in with (`uid`, `email`).

# Notes

- ~~**Keep the old `/yandex/exchange` route and `exchangeYandexToken`**~~ *(Historical: both
  flows were kept during the spike for A/B comparison, then the access-token flow was removed
  once Approach A verified — JWT is now the only Yandex path. See
  `docs/active-task/2026-05-14-remove-yandex-access-token-flow.md`.)*
- The JWT's `exp` is short-ish; test with a fresh login, not a stale token.
- `/info?format=jwt` returns the JWT as a plain-text body — that's why the hook uses
  `res.text()`, not `res.json()`.
- This test app uses its **own** Yandex client_id/secret — findings transfer to the real AM
  app *only* in shape (does verification work, which encoding, which claims), not in literal
  values. The real AM app must repeat the `client_secret` check with its own credentials.
