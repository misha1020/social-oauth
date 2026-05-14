# Yandex JWT Auth — Production Mobile Implementation

**Audience:** Mobile dev adding "Sign in with Yandex" to the production AM Expo app
(React Native + GraphQL).

**Status:** Spec, ready to implement. **Approach A (native `getJwt()`) was implemented and
verified on a physical Android device on 2026-05-14** in the `social-oauth` test app.

**Builds on:** [`yandex-sdk-implementation-guide.md`](./yandex-sdk-implementation-guide.md) — that
guide's native SDK setup (client registration, the Expo native module scaffold, the config
plugin) is still **~95% correct and required**. This doc is the **delta** for the JWT flow: the
native module additionally calls `getJwt()` and returns the JWT, and the app sends that JWT (not
the access token) to the backend.

**Reference implementation (working, tested):**
- [`app-sdk/modules/expo-yandex-sdk/`](../app-sdk/modules/expo-yandex-sdk/) — the native module
- [`app-sdk/src/hooks/useYandexAuth.ts`](../app-sdk/src/hooks/useYandexAuth.ts) — the app-side hook

**Backend side of this flow:** [`docs/main-app-yandex-jwt-backend.md`](./main-app-yandex-jwt-backend.md)

---

## 0. The flow, and the two approaches

```
[App] tap "Sign in with Yandex"
  → [Native module] Yandex SDK login  → access token  (in native memory)
  → [Native module] sdk.getJwt(token) → Yandex-signed JWT      ← Approach A
  → [App] result.jwt
  → [GraphQL] socialAuthByJwt(provider:"yandex", jwt: result.jwt)
  → [Backend] verifies JWT offline with client_secret → AuthPayload
  → [App] store tokens, navigate home
```

There are two ways to get the JWT. **They produce the byte-identical JWT** — `getJwt()` makes the
*same* `login.yandex.ru/info?format=jwt` request internally that the JS fetch makes.

| | **Approach A — native `getJwt()`** | Approach B — JS fetch |
|---|---|---|
| Where the JWT-fetch runs | inside the native module | in JS (`fetch`) |
| Access token enters JS? | **no** — stays in native memory | yes — the hook holds it briefly |
| Native module change? | yes (a few lines of Kotlin/Swift) | no |
| Status | **✅ Android: verified on-device 2026-05-14**; iOS: edited, pending first build (§3) | ✅ verified; see Appendix |

**Use Approach A** (this doc's main body). It keeps the access token out of the JS layer — a
clean-architecture / defense-in-depth win. Approach B is in the **Appendix** as the
no-native-change fallback. On iOS, Approach A is just a one-line change (the JWT comes free in
the login result — see §3), so it's worth doing on both platforms.

> Note: Approach A is **not** "more secure on the network" — `getJwt()` still makes the same
> HTTPS request to Yandex with the access token; it's just made by native code instead of JS. The
> only delta is that the access token never reaches the JS layer.

---

## 1. Native SDK setup — from `yandex-sdk-implementation-guide.md`, mostly unchanged

Do all of this first, exactly as that guide describes — it is **not** repeated here:

- **§2** — Yandex OAuth client registration (production `applicationId` + **release-keystore**
  SHA-256, *not* the test app's). Scopes `login:info`, `login:email`, `login:avatar`.
- **§3.1–3.6** — the `modules/expo-yandex-sdk/` scaffold: `expo-module.config.json`, `index.ts`,
  types, `src/index.ts`, `android/build.gradle`, the empty `AndroidManifest.xml`.
- **§4** — the `withYandexSDK` config plugin (`manifestPlaceholders["YANDEX_CLIENT_ID"]`), and
  `app.json` wiring. **Skip `withCleartextHttp`** — that's dev-only; production is HTTPS.
- **§8** — build environment (JDK 17, Gradle, the build cycle).
- **§10** — the pitfalls table still applies verbatim.

**The only files that differ from that guide are the native module's success branch + its types
+ the app hook** — covered in §2–§4 below. Where this doc and the SDK guide overlap, **this doc
wins** (it reflects the as-built, JWT-flow code).

---

## 2. Android — the `getJwt()` change (Approach A)

### 2.1 The `getJwt` API (verified against the SDK AAR)

`com.yandex.android:authsdk:3.2.0` exposes:

```java
public interface com.yandex.authsdk.YandexAuthSdk {
  String getJwt(com.yandex.authsdk.YandexAuthToken) throws com.yandex.authsdk.YandexAuthException;
}
```

- It's a method on the **`YandexAuthSdk` instance** the module already holds (`sdk`).
- It takes the **`YandexAuthToken`** that `YandexAuthResult.Success` already gives you (`result.token`).
- It returns the **JWT string**, and may throw `YandexAuthException`.
- ⚠️ **It makes a blocking network call** (`login.yandex.ru/info?format=jwt` — there's a
  `JwtRequest` class in the AAR). It **must not** run on the activity-result callback thread (the
  main thread) or you'll get `NetworkOnMainThreadException`. Run it on a worker thread.

### 2.2 `ExpoYandexSDKModule.kt` — the `Success` branch (as-built)

In `modules/expo-yandex-sdk/android/.../ExpoYandexSDKModule.kt`, the `YandexAuthResult.Success`
branch inside the `activityResultRegistry.register { result -> ... }` callback. Replace the
plain `resolvePending(...)` with:

```kotlin
is YandexAuthResult.Success -> {
    val token = result.token
    val activeSdk = sdk
    // getJwt() makes a blocking network call to login.yandex.ru/info?format=jwt
    // — it must NOT run on this result callback (the main thread). Off-thread it.
    Thread {
        if (activeSdk == null) {
            rejectPending("Yandex SDK not initialised — cannot fetch JWT")
        } else {
            try {
                val jwt = activeSdk.getJwt(token)
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
        }
    }.start()
}
```

Notes:
- `accessToken` / `expiresIn` are still returned — harmless, and useful for debugging. The app
  just won't use `accessToken` anymore.
- The explicit `activeSdk == null` check rejects honestly instead of returning an empty-string
  JWT (the spike's first draft used `sdk?.getJwt(token) ?: ""`, which would have sent `""` to the
  backend — don't do that).
- `resolvePending` / `rejectPending` are called from the worker thread; Expo's `Promise` is
  safe to resolve from any thread.
- The `Cancelled` and `Failure` branches are **unchanged**.

### 2.3 Native module types — add `jwt`

In `modules/expo-yandex-sdk/src/ExpoYandexSDK.types.ts`:

```typescript
export type YandexAuthSuccess = {
  cancelled?: false;
  accessToken: string;
  expiresIn: number;
  // Yandex-signed JWT, fetched natively via the SDK's getJwt() (Approach A).
  jwt: string;
};
```

`YandexAuthCancelled` and `YandexAuthResult` are unchanged.

---

## 3. iOS — the parallel change (✅ edited, ⚠️ unverified until first iOS build)

The iOS native module ([`ExpoYandexSDKModule.swift`](../app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDKModule.swift))
exists but **has never been compiled or run** (the test app is Android-only). The Approach-A
edit *has been applied* — but it can't be compile-checked here, so treat §3 as "written,
pending an iOS build" rather than "verified".

### 3.1 iOS is simpler than Android — the JWT comes free in the login result

Unlike Android — where `getJwt()` is a *separate blocking network call* that has to be
off-threaded — Yandex's iOS SDK delivers the JWT **directly in the login-finished callback,
alongside the access token**: `result.token` and `result.jwt` are both populated on the same
`YXLoginResult`. No extra call, no worker thread.

### 3.2 `ExpoYandexSDKModule.swift` — the success branch (as-edited)

The `didFinishLogin(with result:)` success branch now adds `jwt` to the resolved map:

```swift
case .success(let r):
  promise.resolve([
    "accessToken": r.token,
    "expiresIn": r.expiresIn ?? 0,
    "jwt": r.jwt
  ])
```

`accessToken` / `expiresIn` are still returned (harmless, useful for debugging) — the app just
won't use `accessToken` anymore, exactly like Android.

### 3.3 What still must be verified at the first iOS build

Do **not** ship iOS without a real device build closing these:

1. **Class / delegate names.** This module's Swift uses `YXLoginSDK` / `YXLoginResult` /
   `YXLoginSDKObserver` / `didFinishLogin(with: Result<…>)`. Yandex's older (2.x, ObjC-era)
   docs show `YXLLoginResult` / `loginDidFinish(with:)`. The exact names depend on the SDK
   version — align the Swift to whatever the pinned version's headers actually expose.
2. **The `jwt` property.** Confirm it's named `jwt` and whether it's `String` or `String?`.
   If optional, add a nil guard and `reject` — never resolve with an empty string (the backend
   would reject a `""` JWT). The Swift file has a comment marking this.
3. **Podspec version + channel.** [`ExpoYandexSDK.podspec`](../app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDK.podspec)
   is now pinned to `YandexLoginSDK ~> 3.0` (Yandex's current iOS major; `result.jwt` is
   documented from 2.1.0 onward). Confirm `pod install` resolves it — some versions live only
   on Yandex's private podspec repo and need a `source` line in the host app's Podfile.

### 3.4 Approach B is still the zero-native-change fallback

If you'd rather not touch the iOS native module at all, Approach B (Appendix) works identically
on iOS — the native module just returns `{ accessToken, expiresIn }` and the hook fetches the
JWT in JS. But with the one-line edit above already applied, Approach A on iOS costs only a
first iOS build to confirm §3.3 — there's little reason to diverge platforms.

---

## 4. App-side hook + GraphQL mutation

### 4.1 `useYandexAuth.ts`

The hook calls the native module and sends `result.jwt` to the backend's `socialAuthByJwt`
mutation. Adapt to your generated GraphQL client:

```typescript
import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
// import { useSocialAuthByJwtMutation } from "../generated/graphql";

export interface YandexAuthSuccess {
  accessToken: string;
  refreshToken?: string;
}

export function useYandexAuth(onSuccess: (result: YandexAuthSuccess) => void) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  // const [socialAuthByJwt] = useSocialAuthByJwtMutation();

  const authorize = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await yandexAuthorize();
      if ("cancelled" in result && result.cancelled) {
        setIsLoading(false); // user backed out — silent, not an error
        return;
      }

      // result.jwt was fetched natively via the SDK's getJwt() — the raw access token
      // never entered JS. Send the JWT to the backend's socialAuthByJwt mutation.
      //
      // const { data } = await socialAuthByJwt({
      //   variables: { provider: "yandex", jwt: result.jwt },
      // });
      // if (!data?.socialAuthByJwt?.success) {
      //   throw new Error("Backend rejected Yandex JWT");
      // }
      // onSuccessRef.current({
      //   accessToken: data.socialAuthByJwt.tokens.accessToken,
      //   refreshToken: data.socialAuthByJwt.tokens.refreshToken,
      // });

      throw new Error("TODO: wire socialAuthByJwt mutation here");
    } catch (err: any) {
      setError(err.message || "Yandex authentication failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authorize, isLoading, error };
}
```

The GraphQL mutation (defined backend-side — see the backend doc §2):

```graphql
socialAuthByJwt(provider: "yandex", jwt: $jwt) {
  success
  user { id provider providerId firstName lastName email avatarId }
  tokens { accessToken refreshToken }
}
```

### 4.2 Login button

Unchanged from `yandex-sdk-implementation-guide.md §5.2` — it consumes
`{ authorize, isLoading, error }` and doesn't care how the JWT is obtained.

---

## 5. Build & test

**Build.** Editing the native module's *source* (the Kotlin file + types) does **not** require
`expo prebuild` — `assembleRelease` recompiles the `:expo-yandex-sdk` module. Run `prebuild`
only when `app.json`, a config plugin, `expo-module.config.json`, or a native dependency
changes — e.g. the **first** time you add the module per the SDK guide. (In the test app, the
Approach-A rebuild was a plain `assembleRelease`, no prebuild — Gradle reported 60 tasks
executed vs. 39 for a JS-only change, confirming the module recompiled.)

```bash
# Android release APK (native module source changed → assembleRelease recompiles it):
cd android && JAVA_HOME="<jdk-17-path>" ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

**Test** — the three cases from `yandex-sdk-implementation-guide.md §9` (native SSO with a
Yandex app installed / Chrome-tab fallback / user-cancel) all still apply. Additionally, for the
JWT flow specifically:

- Device log shows `[yandex] JWT: eyJ...` — the JWT came from `getJwt()`.
- Backend verifies it offline and returns `AuthPayload` → app navigates home.
- If the device log shows `getJwt failed: ...` → the SDK's `getJwt()` threw (network, or token
  issue) — the message says which.
- If the app hangs after consent → the worker thread or promise resolution didn't complete.

---

## 6. Delta from `yandex-sdk-implementation-guide.md`

| That guide said | This doc says |
|---|---|
| Native module returns `{ accessToken, expiresIn }` | returns `{ accessToken, expiresIn, **jwt** }` — Android: via `getJwt()` on a worker thread (§2.2); iOS: `result.jwt` straight from the login result (§3.2) |
| `YandexAuthSuccess` type has `accessToken`, `expiresIn` | + `jwt: string` (§2.3) |
| Hook sends `accessToken` to `socialAuthByToken(provider, accessToken)` | Hook sends `result.jwt` to `socialAuthByJwt(provider, jwt)` (§4.1) |
| Backend calls `login.yandex.ru/info` to validate | Backend verifies the JWT offline — see the backend doc |
| `withCleartextHttp` plugin (dev) | Not needed in production — HTTPS only |
| §3.7 Android module success branch | **Replaced** by §2.2 here |
| §7 iOS module success branch | **Replaced** by §3.2 here (iOS scaffold *structure* otherwise unchanged) |
| Everything else (§2 registration, §3.1–3.6 scaffold, §4 plugin, §7 iOS scaffold structure, §8 build, §10 pitfalls) | **Unchanged — still required** |

---

## Appendix — Approach B (JS-side JWT fetch, no native change)

Use this if you don't want to touch the native module at all. The native module stays exactly
as `yandex-sdk-implementation-guide.md` describes (returns `{ accessToken, expiresIn }`, no
`jwt`). The hook fetches the JWT itself:

```typescript
// Same call getJwt() makes internally. The access token goes in the Authorization header
// (NOT a ?oauth_token= query param) so it can't land in URL/access logs.
async function fetchYandexJwt(accessToken: string): Promise<string> {
  const res = await fetch("https://login.yandex.ru/info?format=jwt", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const body = await res.text(); // the response body IS the JWT string
  if (!res.ok) {
    throw new Error(`yandex /info?format=jwt failed: ${res.status} ${body}`);
  }
  return body.trim();
}

// inside authorize(), after `const result = await yandexAuthorize();` and the cancelled check:
const jwt = await fetchYandexJwt(result.accessToken);
// ...then send `jwt` to socialAuthByJwt exactly as in §4.1
```

Trade-off: the access token passes through the JS layer (briefly). The backend is identical
either way — it just verifies the JWT. You can ship Approach B first and migrate Android to
Approach A later with no backend change.

---

## References

- Backend side: [`docs/main-app-yandex-jwt-backend.md`](./main-app-yandex-jwt-backend.md)
- Native SDK setup (the base this builds on): [`yandex-sdk-implementation-guide.md`](./yandex-sdk-implementation-guide.md)
- Working reference module + hook: [`app-sdk/modules/expo-yandex-sdk/`](../app-sdk/modules/expo-yandex-sdk/),
  [`app-sdk/src/hooks/useYandexAuth.ts`](../app-sdk/src/hooks/useYandexAuth.ts)
- Spike write-up: [`docs/yandex-jwt-flow-test-implementation.md`](./yandex-jwt-flow-test-implementation.md)
- Yandex Auth SDK (Android): `com.yandex.android:authsdk:3.2.0`
- Yandex Login SDK (iOS): https://yandex.com/dev/id/doc/en/mobile-sdks/ios-sdk

If this doc conflicts with the reference `app-sdk/` code at runtime, **trust the `app-sdk/`
code** — it's the artifact verified on a physical device.
