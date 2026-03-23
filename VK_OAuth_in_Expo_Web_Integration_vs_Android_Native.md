# VK OAuth in Expo: Web Integration vs Android Native

## Overview

VK (VKontakte) offers two main ways to implement OAuth authorization: via **VK ID SDK** (the modern recommended approach supporting OAuth 2.1 + PKCE) and via the older **VKontakte OAuth 2.0** flow. For an Expo application, the approach diverges significantly depending on whether you're running as a **web target** or a **native Android app**, primarily because of how redirect URIs work and how tokens are exchanged.[^1]

The core difference: a web app uses `https://` redirect URIs and your existing backend callback, while a native Android app requires a **custom URI scheme** (`vk{clientId}://`) deep-linked into the app, plus PKCE instead of a client secret.[^2][^3]

***

## How VK OAuth Works on Web (Your Existing Flow)

Your existing web platform almost certainly follows the **Authorization Code Flow**:

1. The user clicks "Sign in with VK" on the frontend.
2. The browser is redirected to `https://id.vk.ru/authorize` (or `https://oauth.vk.com/authorize`) with `response_type=code`, `client_id`, `redirect_uri` (an `https://` URL on your domain), and optionally `state`.[^4]
3. VK authenticates the user and redirects back to your `redirect_uri` with a `?code=...` query parameter.
4. Your **backend server** exchanges the `code` for an access token by calling `https://oauth.vk.com/access_token` with `client_id`, `client_secret`, `redirect_uri`, and `code`.[^5]
5. The backend returns a session/JWT token to the frontend.

In the VK ID cabinet, you register this application as type **"Web"** and specify a **trusted redirect URL** and **base domain**.[^6]

**Why this works on web:** A web server can securely store the `client_secret` — the token exchange happens server-to-server, never exposing the secret to the browser.[^7]

***

## How VK OAuth Works on Android (Native Flow)

### Why It's Different

Native mobile apps **cannot securely store a `client_secret`** — anyone can unpack an `.apk` and extract hardcoded values. Because of this, the OAuth 2.0 spec (RFC 8252) mandates that native apps use the **Authorization Code Flow with PKCE** (Proof Key for Code Exchange) instead of a client secret.[^8][^7][^2]

Additionally, after authentication VK needs to redirect the user back to the **app** — not a browser URL. This is done via a **custom URI scheme** deep link: `vk{clientId}://vk.ru/blank.html`.[^9][^10]

### VK ID SDK Android Flow (OAuth 2.1)

The official **VK ID SDK for Android** (`VKCOM/vkid-android-sdk`) implements OAuth 2.1 and handles PKCE automatically. Here is the full flow:[^11]

1. User taps the "Sign in with VK ID" button.
2. SDK generates **PKCE parameters**: a random `codeVerifier` (43–128 chars) and `codeChallenge = BASE64(SHA256(codeVerifier))`.[^10][^9]
3. SDK opens a **WebView** (or Chrome Custom Tab) pointing to `https://id.vk.ru/authorize` with `response_type=code`, `client_id`, `redirect_uri=vk{clientId}://vk.ru/blank.html`, and the PKCE params.[^9]
4. User authenticates in the WebView.
5. VK backend generates an authorization `code` and redirects back to `vk{clientId}://vk.ru/blank.html?code=...&state=...&device_id=...`.
6. The custom URI scheme triggers Android to pass the redirect back to the app.
7. The SDK validates `state` and either:
   - **(Frontend exchange):** Directly calls `POST https://id.vk.ru/oauth2/auth` with `code`, `codeVerifier`, `device_id`, `redirect_uri` to get an `access_token`.[^10][^9]
   - **(Backend exchange):** Passes `code`, `codeVerifier`, and `device_id` to your backend, which then calls VK's token endpoint.[^9]
8. VK returns `access_token` + `refresh_token` + `id_token`.[^10]

### Registration Difference

In the VK ID cabinet, an **Android** app is registered differently from a Web app — you provide the **package name** and **SHA-1 fingerprint** of your signing certificate instead of a domain and redirect URL.[^6]

```
// Android app.json (for bare/EAS build)
{
  "android": {
    "package": "com.yourapp.name"
  }
}
```

***

## The Two Expo Integration Strategies

### Strategy A: Web-Browser-Based OAuth (`expo-auth-session`)

This is the **Expo-managed / universal** approach. It works on both Android and iOS without writing native code. The flow uses `expo-auth-session` + `expo-web-browser` to open VK's auth page in the system browser and deep-link the result back to your app.[^12][^13]

**How it works on Android:**
- `makeRedirectUri({ scheme: 'yourapp' })` generates a custom scheme redirect like `yourapp://redirect`.[^14][^12]
- This is registered in `app.json` under `scheme` so Android handles it as a deep link.
- After authentication, VK redirects to `yourapp://redirect?code=...`, Android recognizes the scheme, and the app receives the code.

**Code example:**

```typescript
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri, useAuthRequest, exchangeCodeAsync } from 'expo-auth-session';

WebBrowser.maybeCompleteAuthSession(); // closes the browser popup on web

const discovery = {
  authorizationEndpoint: 'https://id.vk.ru/authorize',
  tokenEndpoint: 'https://id.vk.ru/oauth2/auth',
};

export function useVKAuth() {
  const redirectUri = makeRedirectUri({
    scheme: 'yourapp', // must match app.json "scheme"
    path: 'auth/vk',
  });

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: 'YOUR_VK_APP_ID',
      scopes: ['email', 'profile'],
      redirectUri,
      usePKCE: true,
      responseType: 'code',
    },
    discovery
  );

  useEffect(() => {
    if (response?.type === 'success') {
      const { code } = response.params;
      // Send code + codeVerifier to your backend, or exchange directly
      exchangeCodeAsync(
        {
          clientId: 'YOUR_VK_APP_ID',
          redirectUri,
          code,
          extraParams: {
            code_verifier: request?.codeVerifier ?? '',
            device_id: response.params.device_id ?? '',
          },
        },
        discovery
      ).then((tokenResponse) => {
        console.log(tokenResponse.accessToken);
      });
    }
  }, [response]);

  return { promptAsync, request };
}
```

**app.json:**
```json
{
  "expo": {
    "scheme": "yourapp",
    "android": {
      "package": "com.yourapp.name"
    }
  }
}
```

**Caveat:** VK must have `yourapp://auth/vk` added as a trusted redirect URI. VK's OAuth can be strict about allowed redirect scheme formats — you may need to test this in the VK ID app cabinet.[^6]

***

### Strategy B: Native VK ID SDK via Expo Bare / Custom Dev Client

This approach uses the actual **VK ID Android SDK** for native-quality UX (One Tap button, VK app integration, etc.), but requires **bare workflow or an Expo custom dev client / EAS build** since it involves native Kotlin/Java code.[^11]

The React Native bridge `react-native-vk-auth` / `react-native-superappkit-pub` wraps the VK ID native SDK:[^15][^16]

```typescript
import { VK, VKID } from 'react-native-superappkit-pub';

// Initialize once (e.g., in App.tsx)
VK.initialize({
  credentials: {
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret',
  },
  mode: VK.Mode.PRODUCTION,
}, vkid);

// Trigger auth
vkid.startAuth();

// Listen for auth state changes
vkid.setOnAuthChanged({
  onAuth(userSession) {
    if (userSession instanceof VKID.Session.Authorized) {
      userSession.userProfile.then((profile) => {
        console.log(profile.firstName, profile.userID.value);
      });
    }
  },
  onLogout() { /* ... */ }
});
```

The native SDK configures the Android Manifest with `VKIDClientID`, `VKIDClientSecret`, `VKIDRedirectScheme` (`vk{clientId}`), and `VKIDRedirectHost` placeholders automatically:[^11]

```kotlin
// build.gradle.kts (handled automatically by the native module)
android {
    defaultConfig {
        addManifestPlaceholders(
            mapOf(
                "VKIDClientID" to "YOUR_APP_ID",
                "VKIDClientSecret" to "YOUR_SECRET",
                "VKIDRedirectHost" to "vk.com",
                "VKIDRedirectScheme" to "vkYOUR_APP_ID",
            )
        )
    }
}
```

***

## Key Differences: Web vs Android

| Dimension | Web (your existing platform) | Android Native (Expo) |
|---|---|---|
| **Redirect URI** | `https://yourdomain.com/callback` | `vk{clientId}://vk.ru/blank.html` or `yourapp://...` (custom scheme) |
| **VK App Cabinet Type** | Web — enter domain + trusted URL | Android — enter package name + SHA-1 fingerprint[^6] |
| **client_secret** | Used on backend for code exchange | **Never used** on the device — replaced by PKCE[^2] |
| **PKCE** | Optional (recommended) | **Mandatory** for native apps[^8] |
| **Auth UI** | Browser tab / popup | WebView or Chrome Custom Tab inside the app, or VK app if installed[^17] |
| **Token exchange** | Backend (`client_secret` required) | Frontend SDK or backend (with `codeVerifier` only)[^9] |
| **Deep linking** | Not needed | Required — scheme must be registered in AndroidManifest[^3] |
| **VK App one-tap** | Not available | Available if VK app is installed on device[^17] |
| **Token IP binding** | Token bound to server IP (backend exchange) | Token bound to user device IP (frontend) or server IP (backend)[^10] |
| **Expo workflow** | Any | `expo-auth-session` works managed; native SDK requires bare/EAS |

***

## Recommended Architecture for Your Case

Since you already have a working **web OAuth with a backend**, the cleanest approach for Expo is:

1. **Use `expo-auth-session` with PKCE** (Strategy A) for maximum compatibility across managed and bare workflows.
2. Open `https://id.vk.ru/authorize` in the system browser via `WebBrowser.openAuthSessionAsync` or `useAuthRequest`.
3. After receiving the `code` on the app side (via deep link), **send `code` + `codeVerifier` + `device_id` to your existing backend**.
4. Your backend exchanges the code for tokens by calling `https://id.vk.ru/oauth2/auth` — this mirrors the existing web flow but without `client_secret` (uses `codeVerifier` instead).[^18][^4]
5. Backend returns your app's session token (JWT/cookie) as usual.

This lets you reuse your backend OAuth logic, keeping `client_id` and `client_secret` server-side and never exposing them in the mobile app.

**Key app.json changes needed:**
```json
{
  "expo": {
    "scheme": "yourapp",
    "android": {
      "package": "com.yourapp.bundle.id",
      "intentFilters": [
        {
          "action": "VIEW",
          "autoVerify": true,
          "data": [{ "scheme": "yourapp" }],
          "category": ["BROWSABLE", "DEFAULT"]
        }
      ]
    }
  }
}
```

**VK ID Cabinet — you need TWO separate app registrations:**
- **Web** app: existing registration with your `https://` redirect URL.
- **Android** app: new registration with your bundle package name (`com.yourapp.bundle.id`) and SHA-1 fingerprint of the EAS signing key.[^19][^6]

***

## Open Source Projects & References

- **[VKCOM/vkid-android-sdk](https://github.com/VKCOM/vkid-android-sdk)** — Official VK ID SDK for Android (Kotlin, OAuth 2.1, PKCE). Version 2.x supports OAuth 2.1 + Odnoklassniki + Mail login.[^11]
- **[somersets/react-native-vk-auth](https://github.com/somersets/react-native-vk-auth)** — React Native wrapper around `react-native-superappkit-pub`, the VK SuperAppKit for RN. Provides `VKOneTapButton` component.[^16]
- **[doomsower/react-native-vkontakte-login](https://github.com/doomsower/react-native-vkontakte-login)** — Older but widely referenced RN wrapper around native VK SDKs for Android and iOS; exposes `VKLogin.login(['friends', 'photos'])` API. Requires bare workflow.[^20]
- **[expo-auth-session docs](https://docs.expo.dev/versions/latest/sdk/auth-session/)** — Official Expo AuthSession reference; describes `useAuthRequest`, `makeRedirectUri`, and `WebBrowser.maybeCompleteAuthSession()` patterns.[^13][^12]
- **[Expo authentication guide](https://docs.expo.dev/guides/authentication/)** — Contains working examples for OAuth flows with `expo-auth-session` including code exchange patterns.[^13]
- **[VK ID OAuth 2.1 realization docs](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/realization)** — Official spec for VK ID's OAuth 2.1 flow, covering PKCE, token exchange, and redirect URI formats.[^4]
- **[VK ID Android auth flow docs](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/start-integration/how-auth-works/auth-flow-android)** — Detailed diagrams of frontend vs backend exchange flows for Android.[^9]
- **[habr.com — OAuth в мобильных приложениях](https://habr.com/ru/companies/kts/articles/654029/)** — Russian-language deep dive into mobile OAuth flows, PKCE, and security considerations.[^21]
- **[oauth.com — Mobile and Native Apps](https://www.oauth.com/oauth2-servers/mobile-and-native-apps/)** — Authoritative guide on OAuth best practices for native apps including custom scheme redirect URIs.[^3][^2]

***

## Common Pitfalls

- **SHA-1 mismatch**: EAS production builds use a different signing key than debug — you need to add both SHA-1 fingerprints (debug + release) to the VK ID Android app registration.[^19][^6]
- **Custom schemes not allowed by VK**: Older VK OAuth 2.0 endpoints may not accept custom scheme URIs (`yourapp://`). In that case, use `vk{clientId}://` format with the `VKIDRedirectScheme` manifest placeholder.[^10][^9]
- **`maybeCompleteAuthSession()` required on web**: Without this call, the auth popup will not close on the web target.[^22][^12]
- **Token IP binding**: If you use frontend token exchange, the access token is bound to the user's device IP. Sending this token to a different backend server will cause auth errors — use backend exchange instead.[^10]
- **Expo Go limitations**: Custom URI scheme deep linking does not work in Expo Go. You must use an EAS development build or `expo prebuild` + local run for testing.[^23][^24]

---

## References

1. [Authorization from VK | VK for developers](https://dev.vk.com/en/vkid/install-sdk/web) - To allow users to sign in to your app via a VK ID account, you can use either the VK ID SDK or VK OA...

2. [Mobile and Native Apps](https://www.oauth.com/oauth2-servers/mobile-and-native-apps/) - Mobile apps must also use an OAuth flow that does not require a client secret. The current best prac...

3. [Redirect URLs for Native Apps - OAuth 2.0 Simplified](https://www.oauth.com/oauth2-servers/redirect-uris/redirect-uris-native-apps/) - Native applications are clients installed on a device, such as a desktop application or native mobil...

4. [Реализация OAuth 2.1 в VK ID](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/realization) - Реализация OAuth 2.1 в VK ID. VK ID позволяет настроить авторизацию пользователя с помощью протокола...

5. [Получение access_token vk api](https://ru.stackoverflow.com/questions/1474407/%D0%9F%D0%BE%D0%BB%D1%83%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-access-token-vk-api) - Для получения access_token необходимо выполнить запрос с вашего сервера на https://oauth.vk.com/acce...

6. [VK ID. Сервис авторизации. Как правильно указать ...](https://id.vk.com/about/faq/business/vkid/app/30004) - Для приложения на платформе типа Web в сервисе авторизации VK ID нужно заполнить поля Базовый домен ...

7. [Why does the Oauth technique differ for a web browser ...](https://stackoverflow.com/questions/71123427/why-does-the-oauth-technique-differ-for-a-web-browser-traditional-web-app-not) - The main difference between the two lies in the fact that a web app can have secrets and a native ap...

8. [OAuth Flows Explained: Types and When to Use Them](https://frontegg.com/blog/oauth-flows) - Learn about different OAuth flows, including authorization code, implicit, and more. Discover their ...

9. [Как работает авторизация VK ID на Android](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/start-integration/how-auth-works/auth-flow-android) - VK ID SDK запрашивает обмен кода авторизации на Access token. Для этого передается: код авторизации;...

10. [Настройка авторизации VK ID для Android](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/setting-up-auth/setup-android) - Если вы используете схему авторизации через SDK с обменом кода на бэкенде, сгенерируйте параметры PK...

11. [VKCOM/vkid-android-sdk](https://github.com/VKCOM/vkid-android-sdk) - Чтобы подключить VK ID SDK, сначала получите ID приложения (app_id) и защищенный ключ (client_secret...

12. [Expo AuthSession](https://docs.expo.dev/versions/latest/sdk/auth-session/) - AuthSession enables web browser-based authentication (for example, browser-based OAuth flows) in you...

13. [Authentication with OAuth or OpenID providers](https://docs.expo.dev/guides/authentication/) - Learn how to utilize the expo-auth-session library to implement authentication with OAuth or OpenID ...

14. [Expo AuthSession (proxy) sends Android users to 404 route after authenticating · Issue #157 · expo/router](https://github.com/expo/router/issues/157) - Summary When Expo Router is used in conjunction with Expo Auth Session, Android users are sent to th...

15. [@devsomersets/react-native-vk-auth](https://www.npmjs.com/package/@devsomersets%2Freact-native-vk-auth) - Поддержка URL схемы Чтобы пользователь мог авторизоваться бесшовно, SDK взаимодействует с клиентом V...

16. [GitHub - somersets/react-native-vk-auth](https://github.com/somersets/react-native-vk-auth) - Contribute to somersets/react-native-vk-auth development by creating an account on GitHub.

17. [VK SDK Android — Auth](https://vksdk.github.io/vk-sdk-android/auth/) - Auth¶. For the detailed information about the VK auth process, see the official documentation: https...

18. [Обмен токена на информацию о пользователе](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/work-with-user-info/user-info) - Есть два способа получения Access token по Authorization Code Flow: (рекомендуемый) когда обмен авто...

19. [how do I get SHA-1 certificate in expo?](https://stackoverflow.com/questions/61119983/how-do-i-get-sha-1-certificate-in-expo) - Is there a certain command in expo to get the certificate? All the guide I find are for just react-n...

20. [doomsower/react-native-vkontakte-login](https://github.com/doomsower/react-native-vkontakte-login) - This module is a wrapper around native VK SDKs for Android (v1) (VK, github) and iOS (VK, github). I...

21. [OAuth в мобильных приложениях](https://habr.com/ru/companies/kts/articles/654029/) - При использовании Authorization Code Flow with PKCE cхема немного меняется. Отличия выделены. Пользо...

22. [[expo-auth-session] useAuthRequest response type= ...](https://github.com/expo/expo/issues/25871) - When I press login button on web, popup screen opens with login form. After successful login, the po...

23. [Deep linking / AuthSessions don't function - "Can't make a deep link into a standalone app with no custom scheme defined" · Issue #117 · expo/snack](https://github.com/expo/snack/issues/117) - Summary Expo Snack features that use deep linking like AuthSessions cause Snack to throw the followi...

24. [expo/docs/pages/versions/unversioned/sdk/auth-session.md at master · expo/expo](https://github.com/expo/expo/blob/master/docs/pages/versions/unversioned/sdk/auth-session.md) - An open-source framework for making universal native apps with React. Expo runs on Android, iOS, and...

