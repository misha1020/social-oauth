# Yandex ID SDK Login — Implementation Guide for Expo + GraphQL Apps

**Audience:** Another Claude (or developer) implementing Yandex ID SDK login in an Expo React Native app whose backend is a GraphQL service. This guide is self-contained — you do **not** need to read any other doc in the source repo.

**What this enables:** A "Sign in with Yandex" button that opens the Yandex app's confirm sheet (when installed) for one-tap SSO, or falls back automatically to a Chrome Custom Tab. Returns a JWT from your backend.

**Verified working:** Android release APK on physical device (2026-05-08). iOS code is included but unverified (cloud build needed).

---

## 1. Architecture

```
[App] tap "Sign in with Yandex"
  ↓
[Native module: ExpoYandexSDK.authorize()]
  ↓ (Yandex Auth SDK 3.2.0 picks strategy)
  ↓
  ├─ [Yandex app installed] → SSO confirm sheet → returns access_token
  └─ [no Yandex app]        → Chrome Custom Tab → user logs in → returns access_token
  ↓
[App] receives { accessToken, expiresIn }
  ↓
[GraphQL mutation: socialAuthByToken(provider:"yandex", accessToken:"...")]
  ↓
[Backend resolver]
  ↓
  ├─ GET https://login.yandex.ru/info  (with Authorization: OAuth <accessToken>)
  ↓
[Yandex] returns { id, login, default_email, default_avatar_id, first_name, last_name }
  ↓
[Backend] upserts user, signs JWT, returns AuthPayload
  ↓
[App] stores JWT, navigates to home screen
```

Key insight: **the access_token validation happens on the backend**, not the app. The app is just a courier. This matches Yandex's recommended server-side validation pattern.

---

## 2. Yandex OAuth client registration (manual, do this first)

You need a `client_id` before any code can run. Go to https://oauth.yandex.com/client/new and:

1. **App type:** "For user authorization" (not "For API access").
2. **Platforms → Android app:**
   - **Package name:** your app's `applicationId` (e.g. `ru.example.myapp`).
   - **SHA-256 fingerprint:** the cert your release APK is signed with. To get it:
     ```bash
     # Adjust path to your release keystore. Default debug keystore:
     keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey \
       -storepass android -keypass android | grep "SHA256:"
     ```
     **Note for Expo dev builds on Windows:** the project debug keystore is at `android/app/debug.keystore` (after first prebuild). If your release builds are debug-signed (default Expo release config does this — check `android/app/build.gradle` for `signingConfig signingConfigs.debug` under the release block), one fingerprint covers both build types.
3. **Scopes:** check `login:info`, `login:email`, `login:avatar`. Add others your app actually needs.
4. **Save** → copy the generated **ID** (a 32-char hex string). This is your `client_id`. Treat it as semi-public (it's bundled into the APK manifest), but don't post it anywhere bots can scrape.

---

## 3. Android native module

Create the directory `modules/expo-yandex-sdk/` in your Expo project (sibling to `app/`, `src/`, etc.) with the structure below.

### 3.1 `modules/expo-yandex-sdk/expo-module.config.json`

```json
{
  "platforms": ["android", "ios"],
  "android": {
    "modules": ["expo.modules.yandexsdk.ExpoYandexSDKModule"]
  },
  "ios": {
    "modules": ["ExpoYandexSDKModule"],
    "appDelegateSubscribers": ["ExpoYandexSDKAppDelegate"]
  }
}
```

The `appDelegateSubscribers` entry registers the URL-callback handler defined in section 7.3 so the native Yandex-app SSO flow can complete on iOS. Drop that line if you delete `ExpoYandexSDKAppDelegate.swift`.

### 3.2 `modules/expo-yandex-sdk/index.ts`

```typescript
export { authorize } from "./src";
export type {
  YandexAuthResult,
  YandexAuthSuccess,
  YandexAuthCancelled,
} from "./src/ExpoYandexSDK.types";
```

### 3.3 `modules/expo-yandex-sdk/src/ExpoYandexSDK.types.ts`

```typescript
export type YandexAuthSuccess = {
  cancelled?: false;
  accessToken: string;
  expiresIn: number;
};

export type YandexAuthCancelled = {
  cancelled: true;
};

export type YandexAuthResult = YandexAuthSuccess | YandexAuthCancelled;
```

### 3.4 `modules/expo-yandex-sdk/src/index.ts`

The try/catch around `requireNativeModule` matters — without it, importing this module crashes the JS bundle in Expo Go (which doesn't have native modules). With the wrap, only `authorize()` calls fail, so unrelated screens still load.

```typescript
import type { YandexAuthResult } from "./ExpoYandexSDK.types";

let ExpoYandexSDK: any = null;
try {
  ExpoYandexSDK = require("expo-modules-core").requireNativeModule("ExpoYandexSDK");
} catch {
  // Native module not available (Expo Go) — authorize will throw at call time
}

export async function authorize(): Promise<YandexAuthResult> {
  if (!ExpoYandexSDK) {
    throw new Error(
      "Yandex SDK is not available in Expo Go. Use a development build or release APK."
    );
  }
  return ExpoYandexSDK.authorize();
}
```

### 3.5 `modules/expo-yandex-sdk/android/build.gradle`

⚠ The `androidx.appcompat` and `androidx.activity-ktx` deps are **required** even though `expo-modules-core` brings them transitively. expo-modules-core uses `implementation` scope which doesn't propagate to the consumer's compile classpath, so you'll see "Unresolved reference 'ComponentActivity'" without these.

```gradle
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'
apply plugin: 'org.jetbrains.kotlin.android'

group = 'expo.modules.yandexsdk'

def safeExtGet(prop, fallback) {
    rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
}

android {
    namespace "expo.modules.yandexsdk"
    compileSdkVersion safeExtGet("compileSdkVersion", 35)

    defaultConfig {
        minSdkVersion safeExtGet("minSdkVersion", 24)
        targetSdkVersion safeExtGet("targetSdkVersion", 35)
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation project(':expo-modules-core')
    implementation "androidx.appcompat:appcompat:1.6.1"
    implementation "androidx.activity:activity-ktx:1.8.2"
    implementation "com.yandex.android:authsdk:3.2.0"
}
```

### 3.6 `modules/expo-yandex-sdk/android/src/main/AndroidManifest.xml`

Stays empty. Yandex SDK ships its own AAR manifest with everything needed (activities, queries, deep-link entries, meta-data placeholder).

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
</manifest>
```

### 3.7 `modules/expo-yandex-sdk/android/src/main/java/expo/modules/yandexsdk/ExpoYandexSDKModule.kt`

⚠ Three things that aren't obvious from the SDK docs and will burn you if you try to follow plan-time research:

1. **`YandexAuthOptions(Context, Boolean isLoggingEnabled)`** — clientId is NOT a constructor parameter (despite some docs implying it is). The SDK reads clientId from manifest meta-data internally.
2. **Lazy `ActivityResultLauncher.register()` inside `authorize()`** — registering in module `OnCreate` would fire before `appContext.currentActivity` is bound, leaving the launcher null forever.
3. **`YandexAuthLoginOptions` has no zero-arg constructor.** Pass `LoginType.NATIVE`. The SDK's `LoginStrategyResolver` automatically falls back to Chrome Tab when no Yandex app is installed.

```kotlin
package expo.modules.yandexsdk

import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import com.yandex.authsdk.YandexAuthLoginOptions
import com.yandex.authsdk.YandexAuthOptions
import com.yandex.authsdk.YandexAuthResult
import com.yandex.authsdk.YandexAuthSdk
import com.yandex.authsdk.internal.strategy.LoginType
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class YandexAuthException(message: String) : CodedException("YANDEX_AUTH_ERROR", message, null)

class ExpoYandexSDKModule : Module() {
    private var pendingPromise: Promise? = null
    private var launcher: ActivityResultLauncher<YandexAuthLoginOptions>? = null
    private var sdk: YandexAuthSdk? = null

    private fun resolvePending(result: Map<String, Any>) {
        val promise = pendingPromise ?: return
        pendingPromise = null
        promise.resolve(result)
    }

    private fun rejectPending(message: String) {
        val promise = pendingPromise ?: return
        pendingPromise = null
        promise.reject(YandexAuthException(message))
    }

    private fun ensureLauncher(activity: ComponentActivity) {
        if (launcher != null) return

        // SDK reads clientId from <meta-data android:name="com.yandex.auth.CLIENT_ID"> in the merged manifest.
        val options = YandexAuthOptions(activity.applicationContext, false)
        val newSdk = YandexAuthSdk.create(options)
        sdk = newSdk

        launcher = activity.activityResultRegistry.register(
            "expo-yandex-sdk-auth",
            newSdk.contract
        ) { result ->
            when (result) {
                is YandexAuthResult.Success -> {
                    resolvePending(
                        mapOf(
                            "accessToken" to result.token.value,
                            "expiresIn" to result.token.expiresIn
                        )
                    )
                }
                is YandexAuthResult.Cancelled -> {
                    resolvePending(mapOf("cancelled" to true))
                }
                is YandexAuthResult.Failure -> {
                    rejectPending(result.exception.message ?: "Unknown Yandex auth error")
                }
            }
        }
    }

    override fun definition() = ModuleDefinition {
        Name("ExpoYandexSDK")

        AsyncFunction("authorize") { promise: Promise ->
            val activity = appContext.currentActivity as? ComponentActivity
            if (activity == null) {
                promise.reject(YandexAuthException("No current activity (or not a ComponentActivity)"))
                return@AsyncFunction
            }

            if (pendingPromise != null) {
                promise.reject(YandexAuthException("Authorization already in progress"))
                return@AsyncFunction
            }

            try {
                ensureLauncher(activity)
            } catch (e: Exception) {
                promise.reject(YandexAuthException(e.message ?: "Failed to initialise Yandex SDK"))
                return@AsyncFunction
            }

            pendingPromise = promise
            try {
                // LoginStrategyResolver auto-falls-back to Chrome Tab if no Yandex app is installed.
                launcher!!.launch(YandexAuthLoginOptions(LoginType.NATIVE))
            } catch (e: Exception) {
                pendingPromise = null
                promise.reject(YandexAuthException(e.message ?: "Failed to launch Yandex auth"))
            }
        }
    }
}
```

---

## 4. Expo config plugin: `withYandexSDK`

⚠ The Yandex SDK's bundled AAR manifest already declares:

```xml
<meta-data android:name="com.yandex.auth.CLIENT_ID" android:value="${YANDEX_CLIENT_ID}" />
<!-- plus deep-link entries that interpolate the same placeholder -->
```

So the host app must supply `YANDEX_CLIENT_ID` as a `manifestPlaceholders` entry — **not** by injecting another `<meta-data>` element (which causes a manifest-merger collision).

### 4.1 `plugins/withYandexSDK.js`

```javascript
const {
  withAppBuildGradle,
  withInfoPlist,
} = require("@expo/config-plugins");

function withYandexSDK(config, { clientId }) {
  if (!clientId) throw new Error("withYandexSDK: clientId is required");

  // Android: supply the placeholder the SDK's bundled manifest expects.
  config = withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('manifestPlaceholders["YANDEX_CLIENT_ID"]')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /(defaultConfig\s*\{)/,
        `$1\n        manifestPlaceholders["YANDEX_CLIENT_ID"] = "${clientId}"`
      );
    }
    return cfg;
  });

  // iOS: register yx<clientId> URL scheme + Info.plist YandexClientID key.
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.YandexClientID = clientId;
    const scheme = `yx${clientId}`;
    cfg.modResults.CFBundleURLTypes = cfg.modResults.CFBundleURLTypes || [];
    const exists = cfg.modResults.CFBundleURLTypes.some((t) =>
      (t.CFBundleURLSchemes || []).includes(scheme)
    );
    if (!exists) {
      cfg.modResults.CFBundleURLTypes.push({
        CFBundleURLSchemes: [scheme],
      });
    }
    return cfg;
  });

  return config;
}

module.exports = withYandexSDK;
```

### 4.2 `plugins/withCleartextHttp.js` (dev-only)

Only needed if your app needs to talk to a plain-HTTP dev server (e.g. `http://192.168.x.x:5173`). Production traffic is HTTPS so this should not ship to prod.

```javascript
const { withAndroidManifest } = require("@expo/config-plugins");

function withCleartextHttp(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application[0];
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
}

module.exports = withCleartextHttp;
```

⚠ **Symptom if missing:** browser hits `http://<lan>/health` fine on the device, but app's `fetch` returns "Network request failed". Different policy targets — the browser app has its own manifest with cleartext enabled.

### 4.3 Wire into `app.json`

```json
{
  "expo": {
    "plugins": [
      [
        "./plugins/withYandexSDK",
        { "clientId": "PASTE_YOUR_YANDEX_CLIENT_ID_HERE" }
      ],
      "./plugins/withCleartextHttp"
    ]
  }
}
```

---

## 5. App-side React hook + UI

### 5.1 `src/hooks/useYandexAuth.ts`

This wraps the native module + your GraphQL mutation. Replace `socialAuthByToken` with whatever your generated GraphQL client exposes.

```typescript
import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
// import your GraphQL hook/client here, e.g.:
// import { useSocialAuthByTokenMutation } from "../generated/graphql";

export interface YandexAuthSuccess {
  accessToken: string;
  refreshToken?: string;
}

export function useYandexAuth(onSuccess: (result: YandexAuthSuccess) => void) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  // Replace with your actual GraphQL mutation hook.
  // const [socialAuthByToken] = useSocialAuthByTokenMutation();

  const authorize = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await yandexAuthorize();
      if ("cancelled" in result && result.cancelled) {
        // User backed out. Silent — not an error.
        setIsLoading(false);
        return;
      }

      // Send the access_token to your GraphQL backend for validation + JWT exchange.
      // Example shape — adapt to your client:
      //
      // const { data } = await socialAuthByToken({
      //   variables: { provider: "yandex", accessToken: result.accessToken },
      // });
      // if (!data?.socialAuthByToken?.success) {
      //   throw new Error("Backend rejected Yandex token");
      // }
      // onSuccessRef.current({
      //   accessToken: data.socialAuthByToken.tokens.accessToken,
      //   refreshToken: data.socialAuthByToken.tokens.refreshToken,
      // });

      throw new Error("TODO: wire socialAuthByToken mutation here");
    } catch (err: any) {
      setError(err.message || "Yandex authentication failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authorize, isLoading, error };
}
```

### 5.2 Login button

```tsx
import { Pressable, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useYandexAuth } from "../src/hooks/useYandexAuth";

function LoginScreen() {
  const { authorize, isLoading, error } = useYandexAuth(({ accessToken, refreshToken }) => {
    // Persist tokens (SecureStore, etc.) and navigate.
  });

  return (
    <>
      {error && <Text style={{ color: "red" }}>{error}</Text>}
      <Pressable
        style={[styles.yandexButton, isLoading && styles.disabled]}
        onPress={authorize}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in with Yandex</Text>
        )}
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  yandexButton: {
    backgroundColor: "#FC3F1D", // Yandex brand red
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: "center",
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
```

---

## 6. Backend — GraphQL integration

Your existing schema (per your team's `am-qp` GraphQL service):

```graphql
type AuthPayload {
  success: Boolean!
  user: User
  tokens: TokenPair
}

type TokenPair {
  accessToken: String!
  refreshToken: String!
}

# Your existing VK mutation (returns code, not access_token):
extend type Mutation {
  socialAuthCallback(provider: String!, code: String!, deviceId: String!): AuthPayload!
}
```

Yandex returns an `access_token` directly, so `socialAuthCallback`'s shape doesn't fit. **Add a sibling mutation:**

```graphql
extend type Mutation {
  socialAuthByToken(provider: String!, accessToken: String!): AuthPayload!
}
```

### 6.1 Resolver — Yandex profile fetch

The actual Yandex API call is a single GET. Adapt to your stack (Node/TypeScript/Python/etc.). Reference Node.js implementation:

```javascript
// services/yandex.js
async function fetchYandexProfile(accessToken) {
  let res;
  try {
    res = await fetch('https://login.yandex.ru/info?format=json', {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });
  } catch (err) {
    throw new Error(`yandex_unreachable: ${err.message}`);
  }

  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch (_) {}
    throw new Error(`yandex_token_invalid: ${body.error || res.status}`);
  }

  const data = await res.json();
  // Yandex returns: { id, login, default_email, default_avatar_id, first_name, last_name, ... }
  return {
    provider: 'yandex',
    providerId: String(data.id),       // numeric Yandex UID, stringified
    firstName: data.first_name || '',
    lastName: data.last_name || '',
    ...(data.default_email ? { email: data.default_email } : {}),
    ...(data.default_avatar_id ? { avatarId: data.default_avatar_id } : {}),
  };
}

module.exports = { fetchYandexProfile };
```

### 6.2 Resolver wiring (Node/Apollo example)

```javascript
const { fetchYandexProfile } = require('./services/yandex');

const resolvers = {
  Mutation: {
    socialAuthByToken: async (_, { provider, accessToken }, ctx) => {
      if (provider !== 'yandex') {
        // For VK, your existing socialAuthCallback handles code+deviceId.
        // Add other token-based providers here if needed.
        throw new Error(`Unsupported provider for token-based auth: ${provider}`);
      }

      let profile;
      try {
        profile = await fetchYandexProfile(accessToken);
      } catch (err) {
        const msg = err.message || '';
        if (msg.startsWith('yandex_token_invalid')) {
          throw new GraphQLError('YANDEX_TOKEN_INVALID', { extensions: { code: 'UNAUTHENTICATED' } });
        }
        if (msg.startsWith('yandex_unreachable')) {
          throw new GraphQLError('YANDEX_UNREACHABLE', { extensions: { code: 'BAD_GATEWAY' } });
        }
        throw err;
      }

      // Use whatever upsert / token issuance your service already does for VK.
      const user = await ctx.users.upsertByProvider(profile);
      const tokens = await ctx.auth.issueTokens(user);

      return {
        success: true,
        user,
        tokens,
      };
    },
  },
};
```

### 6.3 User schema — generic provider+providerId

If your User table currently has a hard-coded `vkId` column, migrate to a generic shape so VK and Yandex coexist without column collisions:

```sql
-- Before
CREATE TABLE users (
  id UUID PRIMARY KEY,
  vk_id BIGINT UNIQUE,
  ...
);

-- After
CREATE TABLE users (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,           -- 'vk' | 'yandex' | future
  provider_id TEXT NOT NULL,        -- string (Yandex IDs are huge; safer than BIGINT)
  email TEXT,                       -- nullable; not all providers/scopes return it
  avatar_id TEXT,                   -- Yandex uses path-like IDs
  ...
  UNIQUE(provider, provider_id)
);
```

⚠ **Schema migration ripple** — once you change the User model, all client-side TypeScript types and UI references to `vkId` need parallel updates. In our test app this hit three files (`api.ts` MeResponse, `useAuth.ts` User, `home.tsx` display); without those updates, VK login still appears to "work" but the UI shows "VK ID: undefined". Grep for the old field name across the client codebase before declaring the migration done.

### 6.4 Optional: token revocation

After successful validation, you can revoke the Yandex `access_token` to limit its lifetime (currently the app stores nothing — token is discarded after the GraphQL call returns):

```javascript
await fetch('https://oauth.yandex.com/revoke_token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ access_token: accessToken, client_id: YANDEX_CLIENT_ID }),
});
```

Don't await this in the critical path — fire-and-log.

---

## 7. iOS (UNVERIFIED — cloud build needed)

The Swift code below has been hardened relative to first-pass output (scene-aware window lookup, separate AppDelegate subscriber for the OAuth callback URL) but has **not** yet been compiled or run on a device — `pod install` and EAS / local Xcode build are still required. Three things still need on-device verification: (1) `YandexLoginSDK`'s exact API surface for `handleOpen` / `processUserActivity` / `authorize` for the version you pin, (2) the actual `NSError` `domain` / `code` for user cancellation (the `-2` constant is a guess), (3) which CocoaPods source repo serves the version you pin.

### 7.1 `modules/expo-yandex-sdk/ios/ExpoYandexSDK.podspec`

```ruby
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json'))) rescue {}

Pod::Spec.new do |s|
  s.name           = 'ExpoYandexSDK'
  s.version        = '0.1.0'
  s.summary        = 'Yandex ID SDK wrapper for Expo'
  s.author         = ''
  s.homepage       = ''
  s.platforms      = { :ios => '13.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # YandexLoginSDK distribution channel must be verified for the version you pin:
  #   - Some versions are on the public CocoaPods trunk
  #   - Some are only on Yandex's private podspec repo (check the official iOS SDK docs
  #     and add the corresponding `source '...'` line to the host app's Podfile if needed).
  # If `pod install` fails to resolve YandexLoginSDK, the source line is the first thing to fix.
  # The version below is a placeholder — pin to whatever the docs list as current and verify
  # API parity with this module's Swift code (handleOpen, processUserActivity, authorize, ...).
  s.dependency 'YandexLoginSDK', '~> 2.0'

  s.swift_version  = '5.4'
  s.source_files = "**/*.{h,m,swift}"
end
```

### 7.2 `modules/expo-yandex-sdk/ios/ExpoYandexSDKModule.swift`

⚠ `UIApplication.shared.windows.first` is **deprecated in iOS 15+** and unsafe in multi-scene apps. The helper below walks `connectedScenes` → `UIWindowScene` → key window so the auth controller is always presented from the foreground-active scene's key window.

```swift
import ExpoModulesCore
import YandexLoginSDK

public class ExpoYandexSDKModule: Module {
  private var pendingPromise: Promise?

  public func definition() -> ModuleDefinition {
    Name("ExpoYandexSDK")

    OnCreate {
      guard let clientId = Bundle.main.object(forInfoDictionaryKey: "YandexClientID") as? String else {
        return
      }
      try? YXLoginSDK.activate(withAppId: clientId)
      YXLoginSDK.add(observer: self)
    }

    AsyncFunction("authorize") { (promise: Promise) in
      if self.pendingPromise != nil {
        promise.reject("YANDEX_AUTH_ERROR", "Authorization already in progress")
        return
      }
      self.pendingPromise = promise

      DispatchQueue.main.async {
        guard let rootVC = Self.topRootViewController() else {
          self.pendingPromise = nil
          promise.reject("YANDEX_AUTH_ERROR", "No root view controller")
          return
        }
        do {
          try YXLoginSDK.authorize(with: rootVC)
        } catch {
          self.pendingPromise = nil
          promise.reject("YANDEX_AUTH_ERROR", error.localizedDescription)
        }
      }
    }
  }

  private static func topRootViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
    let keyWindow = activeScene?.windows.first(where: { $0.isKeyWindow }) ?? activeScene?.windows.first
    return keyWindow?.rootViewController
  }
}

extension ExpoYandexSDKModule: YXLoginSDKObserver {
  public func didFinishLogin(with result: Result<YXLoginResult, Error>) {
    guard let promise = pendingPromise else { return }
    pendingPromise = nil
    switch result {
    case .success(let r):
      promise.resolve([
        "accessToken": r.token,
        "expiresIn": r.expiresIn ?? 0
      ])
    case .failure(let err):
      let nsErr = err as NSError
      // -2 cancellation code is a placeholder; verify against YandexLoginSDK headers.
      if nsErr.domain == "YXLoginSDKErrorDomain" && nsErr.code == -2 {
        promise.resolve(["cancelled": true])
      } else {
        promise.reject("YANDEX_AUTH_ERROR", err.localizedDescription)
      }
    }
  }
}
```

### 7.3 `modules/expo-yandex-sdk/ios/ExpoYandexSDKAppDelegate.swift` — OAuth callback handler

⚠ This file is **required** for the native-Yandex-app SSO path. Without it, the user signs into Yandex, the Yandex app calls back via `yx<clientId>://...`, iOS opens the host app — and nothing happens, because no one forwarded the URL to `YXLoginSDK`. The `withYandexSDK.js` plugin already adds `yx<clientId>` to `CFBundleURLSchemes`; this subscriber consumes the scheme.

`ExpoAppDelegateSubscriber` is the documented Expo Modules pattern for hooking `application(_:open:options:)` and `application(_:continue:restorationHandler:)`. Register it via `appDelegateSubscribers` in `expo-module.config.json` (section 3.1).

```swift
import ExpoModulesCore
import YandexLoginSDK

// Forwards the OAuth callback URL (yx<clientId>://...) and universal-link continuation
// to YXLoginSDK so the native Yandex app SSO flow can complete.
//
// UNVERIFIED: exact YXLoginSDK API surface (handleOpen vs processUserActivity, parameter
// labels, throws vs Bool return) varies across SDK versions. Verify against the version
// pinned in the podspec at first iOS build and adjust if compile errors appear.
public class ExpoYandexSDKAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    do {
      try YXLoginSDK.handleOpen(url: url, sourceApplication: options[.sourceApplication] as? String)
      return true
    } catch {
      return false
    }
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    do {
      try YXLoginSDK.processUserActivity(userActivity)
      return true
    } catch {
      return false
    }
  }
}
```

### 7.4 URL scheme registration

The `yx<clientId>` URL scheme + `YandexClientID` Info.plist key are written by `withYandexSDK.js` (section 4.1) — no additional manual Info.plist edits needed.

### 7.5 First-build checklist for iOS

1. Run `npx expo prebuild --platform ios --clean` to regenerate `ios/` from `app.json` + plugins.
2. (If your team has a custom Podfile source for Yandex) verify the `source '...'` line is present in `ios/Podfile`.
3. Run `cd ios && pod install`. If `YandexLoginSDK` doesn't resolve, fix the source repo or the version pin first.
4. If the Swift compiler complains about `try YXLoginSDK.handleOpen(...)` or `processUserActivity`, the SDK version you pinned likely uses a non-throwing `Bool`-returning signature instead — drop the `try` and return the result directly.
5. Build a development client via EAS (or local Xcode). The OAuth flow can only be exercised on a real device or simulator with the Yandex app — Expo Go doesn't load native modules.
6. After Case A (Yandex app installed) succeeds for the first time, observe the actual cancel `NSError.domain` / `code` and replace the `-2` placeholder in [section 7.2](#72-modulesexpo-yandex-sdkiosexpoyandexsdkmoduleswift).

---

## 8. Build environment

**JDK 17 required.** Yandex SDK + modern Expo build chain expect Java 17. On Windows for example:

```bash
JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot"
```

**Gradle:** stay on whatever Gradle your Expo SDK already uses. Don't gratuitously upgrade Expo to SDK 55+ — it pulls Gradle 9.0 which is a fresh ~242 MB download.

**Build cycle:**

```bash
# 1. Apply config plugins to native projects
npx expo prebuild --clean --no-install

# 2. (Windows) recreate android/local.properties with double-escaped backslashes:
echo 'sdk.dir=C\:\\Users\\<USER>\\AppData\\Local\\Android\\Sdk' > android/local.properties

# 3. Build release APK
cd android && JAVA_HOME="<your-jdk-17-path>" ./gradlew assembleRelease

# 4. Install (device connected via adb)
adb install -r app/build/outputs/apk/release/app-release.apk
```

After `--clean prebuild`, `local.properties` is wiped and must be recreated.

---

## 9. Testing checklist

Three cases to cover. Do all three before declaring it done.

**Case A — native SSO (Yandex app installed):**

1. Install one of these on the device and sign in to a Yandex account: `com.yandex.browser`, `ru.yandex.searchplugin`, `com.yandex.searchapp`, `ru.yandex.taxi`, `ru.yandex.mail`, `ru.yandex.disk`, `com.yandex.bank`, `ru.yandex.key`. (Yandex Browser or Yandex Mail are easiest from Play Store.)
2. Tap "Sign in with Yandex". Expect: Yandex app opens with a "Confirm sign-in to <App>" sheet. Tap Confirm.
3. Expect: returns to your app, navigates to home, JWT issued.

**Case B — Chrome Custom Tab fallback (no Yandex app):**

1. `adb shell pm uninstall com.yandex.browser` (and any others from the list above).
2. Tap "Sign in with Yandex". Expect: Custom Tab opens with `oauth.yandex.com/authorize?...`.
3. Enter Yandex credentials, tap Allow.
4. Expect: returns to app, navigates to home.

**Case C — user cancels:**

1. Tap "Sign in with Yandex".
2. When the confirm sheet (or Custom Tab) opens, press back / close.
3. Expect: returns to login screen with the button re-enabled. **No error message** — cancellation is silent, the hook returns a `{cancelled: true}` result that the hook treats as a no-op.

---

## 10. Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Manifest merger failed: meta-data#com.yandex.auth.CLIENT_ID is also present at [com.yandex.android:authsdk:3.2.0]` | Plugin injected its own `<meta-data>` element instead of using `manifestPlaceholders`. | Use the `withAppBuildGradle` form in 4.1 above, not `withAndroidManifest` + `addMetaDataItemToMainApplication`. |
| `Unresolved reference 'ComponentActivity' / 'ActivityResultLauncher'` at compile time | `expo-modules-core`'s androidx-activity dep doesn't propagate to consumer compile classpath. | Add explicit `androidx.appcompat:1.6.1` + `androidx.activity-ktx:1.8.2` to module's `build.gradle` (3.5 above). |
| `Argument type mismatch: actual type is 'String', but 'Boolean' was expected` on `YandexAuthOptions(...)` | Reading docs that pass clientId as 2nd arg. | SDK 3.2.0 takes `(Context, Boolean isLoggingEnabled)`. ClientId is read from manifest meta-data automatically. |
| `Network request failed` from app, but `/health` works in device's browser | Default-deny cleartext HTTP on Android 9+, app's manifest doesn't allow it. | Add `withCleartextHttp.js` plugin (4.2) for dev. Don't ship to prod — use HTTPS. |
| Yandex auth opens, succeeds, but backend rejects `yandex_token_invalid` | SHA-256 fingerprint registered with Yandex doesn't match the one your APK is signed with. | Re-extract the fingerprint from the *exact* keystore your release config uses (check `android/app/build.gradle` `signingConfigs`), update Yandex cabinet. Don't forget: if release is debug-signed (Expo default), use the debug keystore's fingerprint. |
| Auth completes but user's name / email is empty | Scopes not enabled in Yandex cabinet, or user denied them at consent. | Check `oauth.yandex.com` → your client → Permissions. `login:info` / `login:email` / `login:avatar` must be checked. Yandex won't return fields the user didn't consent to. |
| `app.listen(PORT, callback)` prints "Server running" but the process exits immediately | Windows-specific: `listening` callback fires before EADDRINUSE error event when port is already bound. | Use `.on('listening')` + `.on('error')` form instead so failures print honestly. |

---

## 11. References

- Yandex OAuth cabinet: https://oauth.yandex.com
- Yandex Login API: https://yandex.com/dev/id/doc/en/access#access-token-extracts
- Yandex Auth SDK 3.2.0 on Maven Central: `com.yandex.android:authsdk:3.2.0`
- iOS Yandex Login SDK: https://yandex.com/dev/id/doc/en/mobile-sdks/ios-sdk
- Expo Modules API: https://docs.expo.dev/modules/overview/
- Expo Config Plugins: https://docs.expo.dev/config-plugins/introduction/

If the SDK API surface in this guide ever conflicts with what you observe at compile/runtime, **trust the AAR**. Extract `~/.gradle/caches/modules-2/files-2.1/com.yandex.android/authsdk/<version>/<hash>/authsdk-<version>.aar` and inspect `classes.jar` with `javap -p` — that's how the surprises in this guide were originally discovered. Reading docs is no substitute for reading bytecode when an SDK changes its API between versions.
