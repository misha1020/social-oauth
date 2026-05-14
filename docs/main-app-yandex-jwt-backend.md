# Yandex JWT Auth — Production Backend Implementation

**Audience:** Backend dev integrating Yandex sign-in into the production AM GraphQL service.

**Status:** Spec, ready to implement. Based on the `social-oauth` test app's JWT flow, which was
implemented and **verified end-to-end on a physical Android device on 2026-05-14**.

**Supersedes:** [`backend-handover-yandex.md`](./backend-handover-yandex.md) — that doc described
an *access-token* flow (`socialAuthByToken`, backend calls `login.yandex.ru/info`). **Do not
build that.** Build this instead. The delta is spelled out in §0 and §12.

**Reference implementation (working, tested):**
- [`server/src/services/yandex.js`](../server/src/services/yandex.js) — `verifyYandexJwt`
- [`server/src/routes/auth.js`](../server/src/routes/auth.js) — the `/auth/yandex/exchange-jwt` route
- [`server/tests/services/yandex.test.js`](../server/tests/services/yandex.test.js),
  [`server/tests/routes/auth.yandex-jwt.test.js`](../server/tests/routes/auth.yandex-jwt.test.js) — tests

The test backend is REST/Express; the production service is GraphQL. The logic translates 1:1 —
this doc gives GraphQL-shaped code, the reference files give the proven version.

---

## 0. Why JWT instead of the access token

The earlier handover (`backend-handover-yandex.md`) had the app send a raw Yandex **access
token**, and the backend call `login.yandex.ru/info` to look the user up. Two problems with that:

1. **It never checks which OAuth client the token belongs to.** A valid access token minted for
   *any other* Yandex app would pass `/info` and be accepted.
2. **Every login is a network round-trip** to Yandex, on the critical path.

The JWT flow fixes both. The app fetches a Yandex-**signed JWT** (`login.yandex.ru/info?format=jwt`)
and sends *that*. The backend verifies the JWT's HS256 signature **offline** with the app's
`client_secret`:

- A JWT that verifies against **our** `client_secret` is cryptographically bound to **our**
  `client_id`. It cannot be forged or substituted with a token from another app.
- **No network call to Yandex** — verification is a local signature check.

| | Access-token flow (old, never built) | JWT flow (this doc) |
|---|---|---|
| App sends | raw access token | Yandex-signed JWT |
| Backend does | `GET login.yandex.ru/info` (network) | `jwt.verify(...)` (offline) |
| Client-bound? | ❌ any client's token passes | ✅ bound to our `client_id` |
| Needs `client_secret`? | ❌ no | ✅ **yes** — it's the verification key |
| Network round-trip per login | yes | no |

---

## 1. Prerequisites

| Need | Notes |
|---|---|
| **`YANDEX_CLIENT_SECRET`** env var | **This is new.** The access-token flow didn't need it; the JWT flow *requires* it — it's the HS256 verification key. Must be the secret for the **same `client_id`** the mobile app authenticates under (the JWT is signed with that client's secret; a different client's secret will never verify). Get it from the production Yandex client at https://oauth.yandex.com → your client → "Пароль приложения" / client password. Store it like any other secret (env / secret manager), **never commit it**. |
| A JWT library | Node: [`jsonwebtoken`](https://www.npmjs.com/package/jsonwebtoken) v9+. Any HS256-capable lib in your stack works. |
| `YANDEX_CLIENT_ID` | *Not* needed for verification (the signature check uses only the secret). Keep it around only if you later add token revocation. |

> ⚠️ **`client_secret` is now a server secret with real weight** — it is the key that both signs
> *and* verifies these JWTs (HS256 is symmetric). Anyone with it can mint JWTs your backend will
> trust. Treat it like `JWT_SECRET`.

---

## 2. New GraphQL mutation

```graphql
extend type Mutation {
  socialAuthByJwt(provider: String!, jwt: String!): AuthPayload!
}
```

- Returns the **same `AuthPayload`** as the existing VK `socialAuthCallback` — no client-visible
  contract change beyond the new mutation.
- **Provider-generic on purpose.** Google and Apple sign-in also hand the client a JWT
  (`id_token`). They'd land in this same mutation later — *but* their JWTs are **RS256**, verified
  against the provider's **public JWKS**, not HS256 with a shared secret. So the mutation
  signature is generic; the **resolver branches per provider** for the actual verification (see §7).
- Keep `socialAuthCallback` (VK, `code` + `deviceId`) exactly as-is. VK's code-flow shape is
  genuinely different; don't try to fold it in.
- The never-built `socialAuthByToken` from the old handover doc is **not** added — `socialAuthByJwt`
  replaces it.

---

## 3. JWT verification — the core

### 3.1 Verified facts (from the 2026-05-14 device run)

- **Algorithm:** `HS256`.
- **Key:** the app's `client_secret`, used **directly as a UTF-8 string** — *not* base64- or
  hex-decoded. (The spike's `verifyYandexJwt` probed all three encodings and reported `utf8`. The
  production verifier doesn't need the probe — just use the string.)
- **Issuer:** the `iss` claim is `login.yandex.ru`. Assert it.
- **`exp`:** observed ~**1 year** out. See §9 — this is a real replay-window concern, not a
  "short-lived token".

### 3.2 Reference implementation (production form)

```javascript
// services/yandex.js
const jwt = require('jsonwebtoken');

// Verify a Yandex /info?format=jwt token.
// HS256, key = client_secret as a UTF-8 string (verified on-device 2026-05-14).
// Throws 'yandex_jwt_invalid: <reason>' on any failure.
function verifyYandexJwt(token, clientSecret) {
  try {
    return jwt.verify(token, clientSecret, {
      algorithms: ['HS256'],        // pin the alg — blocks alg-confusion / alg:none
      issuer: 'login.yandex.ru',    // assert iss
    });
  } catch (err) {
    throw new Error(`yandex_jwt_invalid: ${err.message}`);
  }
}

module.exports = { verifyYandexJwt };
```

> The test app's `verifyYandexJwt` ([`server/src/services/yandex.js`](../server/src/services/yandex.js))
> still has the 3-encoding probe — that was the *spike* answering "which encoding?". Now that the
> answer (`utf8`) is known, production uses the one-line form above.

**Non-negotiables:**
- **Pin `algorithms: ['HS256']`.** Without it, a JWT lib will honour the token's own `alg` header —
  an attacker could send `alg: none` or attempt RS/HS confusion.
- **Assert `issuer`.** Cheap extra guard that the token came from Yandex's login service.
- **Never** disable signature verification or use `jwt.decode()` for trust decisions.

---

## 4. Claim → profile mapping

The Yandex JWT carries these 12 claims (observed on the live run — the `name` split surprised the
plan, so map carefully):

| Claim | Use | Note |
|---|---|---|
| `uid` | `providerId` (stringify) | Yandex UIDs can exceed JS safe-integer range — **always `String(uid)`** |
| `name` | split → `firstName` / `lastName` | **Full name in one string.** There is **no** `first_name`/`last_name` pair. Split on whitespace: first token = first name, rest = last name |
| `display_name` | fallback for `name` | short form, e.g. "Имя Ф." |
| `email` | `email` (optional) | claim is **`email`**, *not* `default_email` (that was the access-token `/info` field) |
| `avatar_id` | `avatarId` (optional) | claim is **`avatar_id`**, *not* `default_avatar_id` |
| `login` | — | Yandex login handle; store if useful |
| `gender` | — | e.g. `male` |
| `psuid` | — | per-service user id |
| `iss` | asserted in §3 | `login.yandex.ru` |
| `iat` / `exp` / `jti` | standard registered claims | `jti` is the per-token id — see §9 |

```javascript
function yandexClaimsToProfile(claims) {
  const fullName = (claims.name || claims.display_name || '').trim();
  const [firstName, ...rest] = fullName.split(/\s+/);
  return {
    provider: 'yandex',
    providerId: String(claims.uid),
    firstName: firstName || '',
    lastName: rest.join(' '),
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.avatar_id ? { avatarId: claims.avatar_id } : {}),
  };
}
```

`email` / `avatar_id` only appear if the user granted the matching scope (`login:email`,
`login:avatar`) — don't fail if they're absent.

---

## 5. User upsert + token issuance

Once the profile is in the canonical `{ provider, providerId, firstName, lastName, email?,
avatarId? }` shape, **reuse exactly what VK does** after it has the VK profile — `upsertByProvider`
+ `issueTokens`. The JWT-issuance code is provider-agnostic.

If your VK path currently signs `{ userId, vkId }`, change it to `{ userId, provider, providerId }`
for **both** providers, and coordinate that JWT-payload change with mobile (the test app already
uses `{ userId, provider, providerId }`).

---

## 6. User schema migration ⚠

**Unchanged from `backend-handover-yandex.md §4` — still the riskiest piece. Get it reviewed.**

If the production `users` table still has a VK-specific `vk_id BIGINT UNIQUE`:

```sql
ALTER TABLE users ADD COLUMN provider    TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;
ALTER TABLE users ADD COLUMN avatar_id   TEXT;   -- if not already present

UPDATE users
SET provider = 'vk', provider_id = vk_id::TEXT
WHERE vk_id IS NOT NULL AND provider IS NULL;

ALTER TABLE users ALTER COLUMN provider    SET NOT NULL;
ALTER TABLE users ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_provider_provider_id_uniq UNIQUE (provider, provider_id);

-- Separate, later migration, after code no longer reads vk_id:
-- ALTER TABLE users DROP COLUMN vk_id;
```

`provider_id` is **`TEXT`**, not `BIGINT` — Yandex UIDs are large and other providers use
non-numeric IDs. Two-phase deploy: (1) add columns + backfill + dual-read/write, (2) drop `vk_id`
after the release is stable. If the schema is already generic, skip this section.

---

## 7. Resolver wiring (Node / Apollo reference)

```javascript
const { GraphQLError } = require('graphql');
const { verifyYandexJwt } = require('./services/yandex');

const resolvers = {
  Mutation: {
    socialAuthByJwt: async (_, { provider, jwt: providerJwt }, ctx) => {
      // Per-provider verification. Yandex = HS256 / client_secret.
      // Google & Apple id_tokens would branch here later: RS256 against the provider's JWKS.
      let claims;
      if (provider === 'yandex') {
        const secret = process.env.YANDEX_CLIENT_SECRET;
        if (!secret) {
          throw new GraphQLError('Server misconfigured: YANDEX_CLIENT_SECRET unset', {
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          });
        }
        try {
          claims = verifyYandexJwt(providerJwt, secret);
        } catch (err) {
          throw new GraphQLError('Invalid Yandex JWT', {
            extensions: { code: 'UNAUTHENTICATED', reason: 'YANDEX_JWT_INVALID' },
          });
        }
      } else {
        throw new GraphQLError(`Unsupported provider for JWT auth: ${provider}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const profile = yandexClaimsToProfile(claims);
      const user    = await ctx.users.upsertByProvider(profile);   // same as VK
      const tokens  = await ctx.auth.issueTokens(user);            // same as VK

      return { success: true, user, tokens };
    },
  },
};
```

---

## 8. Error mapping

| Situation | GraphQL error |
|---|---|
| `jwt` arg empty / missing | `BAD_USER_INPUT` |
| `YANDEX_CLIENT_SECRET` unset on server | `INTERNAL_SERVER_ERROR` (code `SERVER_MISCONFIGURED`) |
| Signature / `alg` / `iss` / `exp` check fails | `UNAUTHENTICATED`, reason `YANDEX_JWT_INVALID` |
| `provider` not `yandex` | `BAD_USER_INPUT` |
| Upsert / token-issuance failure | `INTERNAL_SERVER_ERROR` — same as VK path |

Don't leak the raw `jwt.verify` failure message to the client (it can be noisy). Log it
server-side. **Never log the raw `jwt` or `client_secret`.**

---

## 9. Security notes & hardening

The JWT flow is the *only* Yandex path, so its weaknesses matter:

- **`exp` is ~1 year.** A stolen JWT is replayable against the backend for ~12 months. Mitigations
  to consider: track **`jti`** for one-time use (reject a `jti` seen before — the claim set
  includes `jti` for exactly this); and/or treat the Yandex JWT as single-use at login and rely on
  your own short-lived session tokens thereafter (you already issue your own `AuthPayload.tokens`).
- **Transport must be HTTPS.** The JWT is a bearer credential in transit. (The test app talks to a
  cleartext-HTTP dev server — production must not.)
- **`client_secret` is now a high-value secret** (§1) — it both signs and verifies. Rotate it the
  way you'd rotate `JWT_SECRET`.
- Assert `iss` (done in §3). Optionally also check `exp`/`iat` sanity is already handled by
  `jwt.verify`.
- Strip any `_debug` echo / claim logging before production — the test route echoes
  `{ keyEncoding, claims }` for the spike; production returns only `AuthPayload`.

---

## 10. What you do NOT need

- ❌ **No `login.yandex.ru/info` call** — verification is offline. (This is the whole point.)
- ❌ **No `client_id`** for verification — only `client_secret`.
- ❌ **No PKCE / `code_verifier` / redirect URI** — that's VK's code flow.
- ❌ **No token revocation** — optional only; the access token stays on the device and the
  backend never sees it.

---

## 11. Test plan

**Unit** — port [`server/tests/services/yandex.test.js`](../server/tests/services/yandex.test.js):
sign a token with a known secret → verifies; wrong key → throws; `alg: none` → throws; wrong
`iss` → throws.

**Resolver** — port [`server/tests/routes/auth.yandex-jwt.test.js`](../server/tests/routes/auth.yandex-jwt.test.js):
mock `verifyYandexJwt`, cover `BAD_USER_INPUT` (empty jwt) / `SERVER_MISCONFIGURED` /
`UNAUTHENTICATED` / success-path (user upserted, tokens returned).

**Manual** — three GraphQL calls before mobile is wired:

```bash
# 1. Missing jwt → BAD_USER_INPUT
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d '{"query":"mutation { socialAuthByJwt(provider:\"yandex\", jwt:\"\") { success } }"}'

# 2. Garbage jwt → UNAUTHENTICATED / YANDEX_JWT_INVALID
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d '{"query":"mutation { socialAuthByJwt(provider:\"yandex\", jwt:\"not.a.jwt\") { success } }"}'

# 3. Real jwt (grab one from the mobile dev build's `[yandex] JWT:` log)
curl -X POST $API_URL/graphql -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation { socialAuthByJwt(provider:\\\"yandex\\\", jwt:\\\"$REAL_JWT\\\") { success user { id } tokens { accessToken } } }\"}"
# → success: true, user.id present
```

Then: mobile dev build → real device → "Sign in with Yandex" → expect navigation to home.

---

## 12. Delta from `backend-handover-yandex.md`

| `backend-handover-yandex.md` said | This doc says |
|---|---|
| Mutation `socialAuthByToken(provider, accessToken)` | Mutation `socialAuthByJwt(provider, jwt)` |
| Backend calls `GET login.yandex.ru/info` | Backend verifies the JWT offline — **no Yandex call** |
| "You do NOT need `client_secret`" | **You DO need `client_secret`** — it's the verification key |
| "You do NOT need `YANDEX_CLIENT_ID` env var" | Still true — verification uses only the secret |
| Profile from `/info` JSON: `first_name`, `last_name`, `default_email`, `default_avatar_id` | Profile from JWT claims: `name` (split), `email`, `avatar_id` — **different field names** |
| Error `YANDEX_TOKEN_INVALID` / `YANDEX_UNREACHABLE` | Error `YANDEX_JWT_INVALID` (no `UNREACHABLE` — there's no network call to fail) |
| User schema migration (§4) | **Unchanged** — still applies, see §6 here |
| User upsert + token issuance reuses VK path | **Unchanged** — see §5 here |

Everything in `backend-handover-yandex.md §4` (schema migration), `§8` (what you need from
mobile), and `§9` (keep two mutations) still holds. Sections 1–3, 5–7, 10 of that doc are replaced
by this one.

---

## 13. References

- Mobile side of this flow: [`docs/main-app-yandex-jwt-mobile.md`](./main-app-yandex-jwt-mobile.md)
- Working reference backend: [`server/src/services/yandex.js`](../server/src/services/yandex.js),
  [`server/src/routes/auth.js`](../server/src/routes/auth.js)
- Spike write-up & findings: [`docs/yandex-jwt-flow-test-implementation.md`](./yandex-jwt-flow-test-implementation.md),
  [`docs/plans/2026-05-14-yandex-jwt-flow-design.md`](./plans/2026-05-14-yandex-jwt-flow-design.md)
- Yandex Login API: https://yandex.com/dev/id/doc/en/
- Yandex OAuth cabinet (client registration / secret): https://oauth.yandex.com

If this doc ever conflicts with the reference `server/` code at runtime, **trust the `server/`
code** — it's the artifact verified against a real Yandex JWT.
