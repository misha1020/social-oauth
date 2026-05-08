# Yandex OAuth — Backend Handover

**Audience:** Backend dev integrating Yandex sign-in into the production GraphQL service.
**Status:** Mobile native module + flow proven on Android against a test Node/Express backend ([this repo's `/server`](../server)). Production backend changes are still TODO — that's what this doc is about.

**Companion docs:** [Implementation guide §6](./yandex-sdk-implementation-guide.md#6-backend--graphql-integration) has the full code sketch. [`server/src/services/yandex.js`](../server/src/services/yandex.js) and [`server/src/routes/auth.js`](../server/src/routes/auth.js) are working reference implementations you can paste from.

---

## TL;DR

The mobile app gets a Yandex `access_token` from the native SDK and needs to send it to the backend. The existing `socialAuthCallback(provider, code, deviceId)` mutation doesn't fit (Yandex has no `code` / no `deviceId`). Add a sibling mutation that takes a token directly, validate the token against `login.yandex.ru/info`, upsert a user under a generic `{provider, providerId}` shape, return the same `AuthPayload` as VK.

Net new code is ~80 lines. The risky part is the user-table schema migration if it's still VK-specific.

---

## 1. New GraphQL mutation

```graphql
extend type Mutation {
  socialAuthByToken(provider: String!, accessToken: String!): AuthPayload!
}
```

- Same `AuthPayload` as `socialAuthCallback` — no breaking change for the client.
- `provider` is `"yandex"` for now; design for adding `"google"`, `"apple"`, etc. later (they all return tokens directly, not codes).
- Keep `socialAuthCallback` intact for VK.

---

## 2. Resolver — Yandex profile fetch

Single GET, no `client_secret`, no PKCE, no redirect URI:

```
GET https://login.yandex.ru/info?format=json
Authorization: OAuth <accessToken>
```

Reference (Node, from `/server/src/services/yandex.js`):

```javascript
async function fetchYandexProfile(accessToken) {
  let res;
  try {
    res = await fetch('https://login.yandex.ru/info?format=json', {
      method: 'GET',
      headers: { Authorization: `OAuth ${accessToken}` },
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
  return {
    provider: 'yandex',
    providerId: String(data.id),                // numeric UID stringified
    firstName: data.first_name || '',
    lastName:  data.last_name  || '',
    ...(data.default_email      ? { email:    data.default_email }      : {}),
    ...(data.default_avatar_id  ? { avatarId: data.default_avatar_id }  : {}),
  };
}
```

Notes:
- **`Authorization: OAuth <token>`** — that prefix is `OAuth`, not `Bearer`. Yandex's quirk.
- **`?format=json`** — defensive; the endpoint defaults to JSON but the param removes ambiguity.
- **`String(data.id)`** — Yandex IDs can exceed JS safe integer range. Always stringify.
- **Optional fields** — `email` and `avatar_id` only come back if the user granted the matching scope. Don't fail if absent.

---

## 3. User upsert + JWT

Reuse whatever path `socialAuthCallback` uses **after** it gets the VK profile. Once the Yandex profile is in the canonical `{provider, providerId, firstName, lastName, email?, avatarId?}` shape, the JWT-issuance code is identical.

If the existing flow signs `{userId, vkId}` — change it to sign `{userId, provider, providerId}` for both providers. The JWT contract change should be coordinated with mobile (the test app already migrated; production app will too).

---

## 4. User schema migration ⚠

**This is the riskiest piece. Get it reviewed before running on prod.**

If the production `users` table has `vk_id BIGINT UNIQUE`, you need:

```sql
-- New columns
ALTER TABLE users ADD COLUMN provider    TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;
ALTER TABLE users ADD COLUMN avatar_id   TEXT;   -- if not already there

-- Backfill existing VK users
UPDATE users
SET provider = 'vk',
    provider_id = vk_id::TEXT
WHERE vk_id IS NOT NULL AND provider IS NULL;

-- Make required + add uniqueness
ALTER TABLE users ALTER COLUMN provider    SET NOT NULL;
ALTER TABLE users ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_provider_provider_id_uniq UNIQUE (provider, provider_id);

-- Drop the old column AFTER deploying code that no longer reads it (separate migration / release):
-- ALTER TABLE users DROP COLUMN vk_id;
```

Two-phase deploy:
1. Migration adds `provider/provider_id`, backfills, code reads/writes both old `vk_id` and new fields.
2. After release is stable, second migration drops `vk_id` and code stops touching it.

If the schema is already generic, ignore this section.

---

## 5. Error mapping

| Yandex API result                 | GraphQL error                                                |
| --------------------------------- | ------------------------------------------------------------ |
| `401` / `403` from `/info`        | `UNAUTHENTICATED`, code `YANDEX_TOKEN_INVALID`               |
| Network failure / timeout         | `BAD_GATEWAY`, code `YANDEX_UNREACHABLE`                     |
| `5xx` from Yandex                 | `BAD_GATEWAY`, code `YANDEX_UNREACHABLE`                     |
| `200` but missing `id`            | Shouldn't happen — log and return `INTERNAL_SERVER_ERROR`    |
| User upsert / JWT signing failure | `INTERNAL_SERVER_ERROR` — same as VK path                    |

Don't leak Yandex's raw error messages to the client — they're sometimes Russian-language and sometimes contain debug detail. Log them server-side.

**Never log the raw `accessToken`** — it's a bearer credential. Hash or redact in any debug logging.

---

## 6. Resolver wiring (Node/Apollo example)

```javascript
const { GraphQLError } = require('graphql');
const { fetchYandexProfile } = require('./services/yandex');

const resolvers = {
  Mutation: {
    socialAuthByToken: async (_, { provider, accessToken }, ctx) => {
      if (provider !== 'yandex') {
        throw new GraphQLError(`Unsupported provider for token-based auth: ${provider}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      let profile;
      try {
        profile = await fetchYandexProfile(accessToken);
      } catch (err) {
        const msg = err.message || '';
        if (msg.startsWith('yandex_token_invalid')) {
          throw new GraphQLError('Invalid Yandex access token', {
            extensions: { code: 'UNAUTHENTICATED', reason: 'YANDEX_TOKEN_INVALID' },
          });
        }
        if (msg.startsWith('yandex_unreachable')) {
          throw new GraphQLError('Yandex unreachable', {
            extensions: { code: 'BAD_GATEWAY', reason: 'YANDEX_UNREACHABLE' },
          });
        }
        throw err;
      }

      // Reuse the same upsert + JWT issuance the VK path uses.
      const user   = await ctx.users.upsertByProvider(profile);
      const tokens = await ctx.auth.issueTokens(user);

      return { success: true, user, tokens };
    },
  },
};
```

---

## 7. What you do NOT need

- ❌ **`client_secret`** for Yandex — the SDK already exchanged the code. The `/info` endpoint accepts the bearer token alone.
- ❌ **PKCE / code_verifier** — same reason.
- ❌ **Redirect URI** — the mobile SDK owns the redirect, server never sees it.
- ❌ **Token revocation** — optional. If you want to do it, fire-and-log `POST https://oauth.yandex.com/revoke_token` after successful validation. Don't block the response on it.
- ❌ **`YANDEX_CLIENT_ID` env var** — strictly speaking, not needed. The `/info` endpoint validates the bearer token alone. Add it only if you later want to revoke tokens or check `aud`.

---

## 8. What you DO need from the mobile team

Before deploying:

- **Production Yandex `client_id`** — register at `oauth.yandex.com/client/new`:
  - Production Android `applicationId` (NOT `com.vkoauth.appsdk`, which is the test app)
  - Release-keystore SHA-256 fingerprint (NOT the debug keystore)
  - iOS bundle ID (when iOS ships)
  - Scopes: `login:info`, `login:email`, `login:avatar`
- **Confirmation that the app is migrated to call `socialAuthByToken`** — until then you can deploy the resolver behind a feature flag.

---

## 9. Open design question

Should `socialAuthCallback` (VK) and `socialAuthByToken` (Yandex) eventually be unified?

- **Pro:** Apple, Google, Facebook all also return tokens directly, not codes. Long-term every non-VK provider lands in `socialAuthByToken`'s lane. VK is the odd one out, not Yandex.
- **Con:** VK's `code + deviceId` shape really is different — squeezing it into a generic `socialAuth(provider, payload: JSON)` type costs schema clarity for one edge case.
- **Reasonable answer:** keep two mutations indefinitely. `socialAuthCallback` is VK-specific by design; `socialAuthByToken` is the default for any new provider. Only revisit if a third "code-flow" provider shows up.

Worth a 5-minute design call before we commit either way.

---

## 10. Test plan

Three curl tests against the new resolver before mobile gets wired:

```bash
# 1. Missing token
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d '{"query":"mutation { socialAuthByToken(provider:\"yandex\", accessToken:\"\") { success } }"}'
# → BAD_USER_INPUT or UNAUTHENTICATED, depending on validator

# 2. Invalid token
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d '{"query":"mutation { socialAuthByToken(provider:\"yandex\", accessToken:\"definitely-not-a-real-token\") { success } }"}'
# → UNAUTHENTICATED / YANDEX_TOKEN_INVALID

# 3. Real token (grab one from the mobile dev build's debug logs, or from oauth.yandex.com sandbox)
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation { socialAuthByToken(provider:\\\"yandex\\\", accessToken:\\\"$REAL_TOKEN\\\") { success user { id } tokens { accessToken } } }\"}"
# → success: true, user.id present
```

Then mobile dev build → real device → tap "Sign in with Yandex" → expect navigation to home.

---

## 11. Reference points

- Working test resolver: [`server/src/routes/auth.js`](../server/src/routes/auth.js) (REST shape, but the logic translates 1:1)
- Working profile fetcher: [`server/src/services/yandex.js`](../server/src/services/yandex.js)
- Mobile call site: [`app-sdk/src/hooks/useYandexAuth.ts`](../app-sdk/src/hooks/useYandexAuth.ts)
- Yandex Login API docs: https://yandex.com/dev/id/doc/en/access#access-token-extracts
- Yandex OAuth cabinet (for client registration): https://oauth.yandex.com

If anything in this doc conflicts with what you observe at runtime — trust the live `/server` code over this doc. It's the artifact that actually works against a real Yandex token.
