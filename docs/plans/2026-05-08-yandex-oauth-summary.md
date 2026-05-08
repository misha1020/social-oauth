# Yandex OAuth Implementation — Summary

**Status:** ✅ Android complete (end-to-end verified on release APK 2026-05-08). Both VK and Yandex sign-in flows persist users with the new generic `{provider, providerId}` schema. iOS code present and hardened post-execution (see "iOS hardening" section below) but still needs an EAS / Xcode build for compile + on-device verification.

**Companion docs:**
- [Design rationale](./2026-05-07-yandex-oauth-design.md)
- [Implementation plan (21 tasks)](./2026-05-07-yandex-oauth-plan.md)
- [Self-contained handover guide](../yandex-sdk-implementation-guide.md) for porting this to another Expo + GraphQL codebase.

---

## What was built

### Backend (`/server`)

| File | Change |
|---|---|
| `src/services/users.js` | Generic `{provider, providerId, firstName, lastName, email?, avatarId?}` schema. Replaces `findByVkId` with `findByProvider(provider, providerId)`. Idempotent `createUser`. |
| `src/services/vk.js` | `fetchUserProfile` returns `{provider:'vk', providerId, ...}` instead of `{vkId, ...}`. |
| `src/services/yandex.js` | New. `fetchUserProfile(token)` calls `GET https://login.yandex.ru/info?format=json` with `Authorization: OAuth <token>`. Throws `yandex_token_invalid` on 401, `yandex_unreachable` on network error. |
| `src/routes/auth.js` | Added `POST /auth/yandex/exchange`. Added `yandexAppId` to `createAuthRoutes`. JWT payload now `{userId, provider, providerId}`. |
| `src/index.js` | Wires `process.env.YANDEX_CLIENT_ID` into routes. |
| `.env` | Added `YANDEX_CLIENT_ID=53af4a5707a442c59b0d251f83401de1`. |
| `tests/services/users.test.js` | Rewritten for new schema (8 cases). |
| `tests/services/vk.test.js` | Updated assertion for new shape. |
| `tests/services/yandex.test.js` | New (4 cases: happy, scope-omitted, 401, network). |
| `tests/routes/auth.test.js` | Updated mocks/assertions for `provider/providerId`. |
| `tests/routes/auth.yandex.test.js` | New (6 cases: missing field, valid token, persist, idempotent, 401, 502). |

**Tests:** 30/30 passing.

### Native module (`/app-sdk/modules/expo-yandex-sdk`)

New Expo native module wrapping `com.yandex.android:authsdk:3.2.0`.

```
expo-module.config.json       — declares android + ios platforms
index.ts                      — re-exports authorize() + types
src/index.ts                  — try/catch around requireNativeModule (Expo Go safe)
src/ExpoYandexSDK.types.ts    — YandexAuthResult discriminated union
android/build.gradle          — kotlin-android; deps: expo-modules-core, appcompat 1.6.1, activity-ktx 1.8.2, authsdk 3.2.0
android/src/main/AndroidManifest.xml — empty (SDK manifest provides everything)
android/src/main/.../ExpoYandexSDKModule.kt — lazy launcher registration in authorize()
ios/ExpoYandexSDK.podspec     — depends on YandexLoginSDK
ios/ExpoYandexSDKModule.swift — stub (untested locally; flagged for cloud build)
```

### Config plugins (`/app-sdk/plugins`)

| Plugin | Purpose |
|---|---|
| `withYandexSDK.js` | Injects `manifestPlaceholders["YANDEX_CLIENT_ID"]` into `defaultConfig` (the SDK's bundled manifest interpolates `${YANDEX_CLIENT_ID}` into meta-data + deep-link entries). iOS: adds `YandexClientID` Info.plist key + `yx<id>` URL scheme. |
| `withCleartextHttp.js` | Sets `android:usesCleartextTraffic="true"` on `<application>`. Required for the test app to reach the LAN HTTP server in release builds (debug builds get this implicitly). |

### Client (`/app-sdk`)

| File | Change |
|---|---|
| `app.json` | Added `withYandexSDK` (with clientId) and `withCleartextHttp` to plugins array. |
| `src/services/api.ts` | Added `exchangeYandexToken({ accessToken })`. Updated `MeResponse.user` shape to `{provider, providerId, ...}`. |
| `src/hooks/useYandexAuth.ts` | New. Calls native `authorize()`, treats `{cancelled: true}` as silent no-op. |
| `src/hooks/useAuth.ts` | `User` interface migrated to `{provider, providerId, email?, avatarId?}`. |
| `app/login.tsx` | Yandex sign-in button (red `#FC3F1D`) under the VK button. Each button shows its own spinner; both gate on combined `isLoading`. |
| `app/home.tsx` | Renders `{user.provider}: {user.providerId}` instead of hard-coded `VK ID:`. |

---

## Deviations from the plan (and why)

| # | Plan said | Actual implementation | Why |
|---|---|---|---|
| 9 | Strict `requireNativeModule<T>(...)` | Try/catch wrap | Mirrors recent VK module pattern; lets Expo Go load other screens without crashing on import. |
| 10 | `useCoreDependencies()` / `useExpoPublishing()` / `applyKotlinExpoModulesCorePlugin()` | Simple `implementation project(':expo-modules-core')` | VK module uses simpler form and proves it works; reduces Expo modules-core version coupling. |
| 10 | Empty module manifest only | Added `androidx.appcompat:1.6.1` + `androidx.activity:activity-ktx:1.8.2` to module deps | First build attempt failed: `Unresolved reference 'ComponentActivity' / 'ActivityResultLauncher'`. expo-modules-core depends on these as `implementation` so they don't propagate to consumer compile classpath. |
| 11 | Register `ActivityResultLauncher` in module `OnCreate` | Lazy-register inside `authorize()` | Module `OnCreate` fires before `appContext.currentActivity` is reliably bound — would have left launcher null forever. The non-LifecycleOwner overload of `register()` can be called any time. |
| 11 | Read clientId from `applicationInfo.metaData?.getString("YandexClientID")` | Don't read it manually | SDK's own AAR manifest declares `<meta-data android:name="com.yandex.auth.CLIENT_ID" android:value="${YANDEX_CLIENT_ID}"/>` and reads it internally. We just provide the placeholder value. |
| 11 | `YandexAuthOptions(context, clientId)` | `YandexAuthOptions(context, false)` | Build error #2: actual SDK 3.2.0 constructor is `(Context, Boolean isLoggingEnabled)`. Confirmed by extracting the AAR (`/tmp/yandex-authsdk/classes/com/yandex/authsdk/YandexAuthOptions.class`). |
| 11 | `launcher.launch(YandexAuthLoginOptions())` | `launcher.launch(YandexAuthLoginOptions(LoginType.NATIVE))` | No zero-arg constructor in SDK 3.2.0. `LoginStrategyResolver` auto-falls-back to Chrome Tab if no Yandex app is installed. |
| 13 | `withAndroidManifest` + `addMetaDataItemToMainApplication` to inject `<meta-data>` | `withAppBuildGradle` to inject `manifestPlaceholders["YANDEX_CLIENT_ID"]` | Build error #3: SDK's bundled manifest *already* declares the meta-data with placeholder; injecting our own caused manifest-merger collision. Same pattern as `withVKSDK`. |
| 15 | Add `exchangeYandexToken` only | Plus migrate `MeResponse.user`, `useAuth.ts User`, `home.tsx` to new schema | Required ripple from Task 2's server schema change. Without these the app would show "VK ID: undefined" after login. Plan didn't list them. |
| 17 | Single combined `isLoading` driving both spinners | Each button uses its own loading state for spinner; combined for disabled | Combined version spun *both* buttons whenever either flow ran — visually misleading. |
| — | (not in plan) | Added `withCleartextHttp.js` + `usesCleartextTraffic="true"` | Release APK's default-deny cleartext blocked LAN HTTP fetches to the dev server; `/health` worked in browser (different policy) but `fetch` from app failed with "Network request failed". |

## Yandex OAuth registration

- Cabinet: https://oauth.yandex.com/client/new
- App type: **For user authorization**
- Platform: **Android**, package `com.vkoauth.appsdk`, SHA-256 `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C` (debug keystore — also covers release because [`build.gradle`](../../app-sdk/android/app/build.gradle)'s release config signs with the debug keystore)
- Scopes: `login:info`, `login:email`, `login:avatar`
- Resulting `client_id`: `53af4a5707a442c59b0d251f83401de1`

## Diagnostic instrumentation left in place

[`server/src/index.js`](../../server/src/index.js) has a heartbeat interval + signal/error trace handlers, added during a debugging session that revealed the original `app.listen` callback was firing *before* the EADDRINUSE error event on Windows (so it printed "Server running on port 5173" while actually failing to bind). Worth keeping for now since it's also helpful as a liveness signal during dev. Remove or move behind a flag before any non-dev deploy.

## iOS hardening (2026-05-08, post-execution)

After main execution, three structural gaps in the iOS module were patched. **Still untested** — needs `pod install` + EAS / Xcode build to compile-verify and device runs to confirm SDK API parity. Code is locally consistent with the Android module's contract (`{accessToken, expiresIn}` / `{cancelled: true}`).

| File | Change | Why |
|---|---|---|
| `app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDKModule.swift` | Replaced `UIApplication.shared.windows.first?.rootViewController` with a `topRootViewController()` helper that walks `connectedScenes` → `UIWindowScene` → key window. | `windows` is deprecated on iOS 15+ and unsafe in multi-scene apps. Without this, the auth controller could be presented from the wrong window or `nil` on iOS 16+. |
| `app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDKAppDelegate.swift` (new) | `ExpoAppDelegateSubscriber` that forwards `application(_:open:options:)` to `YXLoginSDK.handleOpen(url:sourceApplication:)` and `application(_:continue:restorationHandler:)` to `YXLoginSDK.processUserActivity(_:)`. | The native Yandex-app SSO path requires the host app to consume the `yx<clientId>://` callback URL and forward it to `YXLoginSDK`. Without this, the user signs into Yandex but the OAuth promise never resolves. |
| `app-sdk/modules/expo-yandex-sdk/expo-module.config.json` | Added `"appDelegateSubscribers": ["ExpoYandexSDKAppDelegate"]` under `ios`. | Registers the subscriber above so the Expo AppDelegate forwards URL events to it. |
| `app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDK.podspec` | Pinned `'YandexLoginSDK', '~> 2.0'`; added comment about CocoaPods spec source verification. | Previously declared the dep with no version, which is a guaranteed `pod install` failure or a moving-target build. Source repo (public trunk vs. Yandex private) varies by SDK version — flagged for verification. |

Three things still need on-device verification before iOS can be considered green:

1. **`YXLoginSDK` API surface** — `handleOpen` and `processUserActivity` are written as `throws` calls. If the version pinned actually returns `Bool` without throwing, drop the `try`/`catch` (compile error will flag it).
2. **`YandexLoginSDK` pod source** — may need `source 'https://...'` line in the host app's Podfile if the version isn't on the public trunk.
3. **Cancellation `NSError` code** — the `-2` constant in `didFinishLogin` is still a guess. First successful Case-A run should print the actual `nsErr.code` / `nsErr.domain` so it can be replaced.

See [implementation guide §7.5](../yandex-sdk-implementation-guide.md#75-first-build-checklist-for-ios) for the full first-build checklist.

## Known follow-ups (not done)

- **iOS device testing in EAS cloud build.** With the hardening above, the module is structurally complete on iOS but no longer just a "stub" — the gating issue is now compile + on-device verification, not missing code. Cancellation code `-2` is still a placeholder until then.
- Adapt for the main app's GraphQL backend (`socialAuthCallback(provider, code, deviceId)` — Yandex returns `access_token`, not `code`/`device_id`, so a `socialAuthByToken(provider, accessToken)` mutation is likely needed, or treat the test backend's REST `/auth/yandex/exchange` as a separate shim).
- Optional: revoke Yandex `access_token` after server-side validation via `POST https://oauth.yandex.com/revoke_token`.
- Make `usesCleartextTraffic` dev-only (currently always-on; fine for this test app, but the pattern shouldn't ship to production).
- Replace the misleading `app.listen(PORT, callback)` form with `.on('listening')` + `.on('error')` so EADDRINUSE prints honestly.
