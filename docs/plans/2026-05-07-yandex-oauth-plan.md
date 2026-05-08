# Yandex OAuth Implementation Plan

> **Status:** ✅ Executed 2026-05-08. All 21 tasks complete. Several code blocks below diverged from the as-built result — the SDK's actual API surface differed from plan-time research and forced runtime fixes. **Before treating any specific code block here as authoritative, cross-check with [2026-05-08-yandex-oauth-summary.md](./2026-05-08-yandex-oauth-summary.md) (deviations table) and the live source.** This file is preserved as the historical task ledger; do not re-execute.
>
> **iOS update 2026-05-08 (post-execution):** The Swift module from Task 12 has been hardened — scene-aware window lookup replaces the deprecated `UIApplication.shared.windows.first`, and a new `ExpoYandexSDKAppDelegate.swift` (registered via `appDelegateSubscribers` in `expo-module.config.json`) handles the `yx<clientId>://` callback URL via `YXLoginSDK.handleOpen` / `processUserActivity`. Podspec now pins `'YandexLoginSDK', '~> 2.0'` with a comment about verifying the spec source. Still untested on device — see implementation guide §7.5 for the first-build checklist.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add native Yandex ID SDK login to `/app-sdk` (opens an installed Yandex app for SSO) with backend exchange in `/server` mirroring the existing VK SDK pattern.

**Architecture:** The Yandex Android SDK (`com.yandex.android:authsdk:3.2.0`) and iOS `YandexLoginSDK` return an OAuth `access_token` directly. The app sends the token to `POST /auth/yandex/exchange`, which validates it via `GET https://login.yandex.ru/info`, upserts a user under a new generic `{provider, providerId}` schema, and returns a JWT.

**Tech Stack:** Expo SDK 54 custom dev build, Expo Modules API (Kotlin/Swift), Node 18+/Express 5, Jest+Supertest, jsonwebtoken.

**See also:** [2026-05-07-yandex-oauth-design.md](./2026-05-07-yandex-oauth-design.md) for design rationale.

**Commit policy:** The user prefers to review and commit changes manually. Each task ends with a "Stage and pause for review" step (`git add -p` then stop) instead of `git commit`. Do not run `git commit` at any step.

---

## Phase 1 — Backend: generic users.js + Yandex exchange (TDD)

### Task 1: Refactor users.js to generic `{provider, providerId}` schema

**Files:**
- Modify: `server/src/services/users.js`
- Modify: `server/tests/services/users.test.js`

**Why:** The current schema hard-codes `vkId`. Yandex returns `id` (different namespace). Generic schema lets both providers coexist without column collision.

**Step 1: Update tests to express new contract**

Rewrite `server/tests/services/users.test.js`:

```javascript
const path = require('path');
const fs = require('fs');
const { getUsers, findById, findByProvider, createUser } = require('../../src/services/users');

const TEST_FILE = path.join(__dirname, '../../data/users.test.json');

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
});

afterAll(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('users service (generic provider schema)', () => {
  test('getUsers returns empty array from empty file', () => {
    expect(getUsers(TEST_FILE)).toEqual([]);
  });

  test('createUser adds a VK user', () => {
    const user = createUser(
      { provider: 'vk', providerId: '12345', firstName: 'Ivan', lastName: 'Petrov' },
      TEST_FILE
    );
    expect(user).toMatchObject({
      provider: 'vk',
      providerId: '12345',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });
    expect(user.id).toBeDefined();
    expect(user.createdAt).toBeDefined();
  });

  test('createUser adds a Yandex user with email and avatarId', () => {
    const user = createUser(
      {
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Anna',
        lastName: 'Smirnova',
        email: 'anna@yandex.ru',
        avatarId: '131652443',
      },
      TEST_FILE
    );
    expect(user).toMatchObject({
      provider: 'yandex',
      providerId: '1000034426',
      email: 'anna@yandex.ru',
      avatarId: '131652443',
    });
  });

  test('findByProvider returns existing user', () => {
    createUser({ provider: 'vk', providerId: '99999', firstName: 'Anna', lastName: 'S' }, TEST_FILE);
    const found = findByProvider('vk', '99999', TEST_FILE);
    expect(found).toMatchObject({ provider: 'vk', providerId: '99999' });
  });

  test('findByProvider returns null for unknown', () => {
    expect(findByProvider('vk', '11111', TEST_FILE)).toBeNull();
  });

  test('findByProvider differentiates between providers with same providerId', () => {
    createUser({ provider: 'vk', providerId: '42', firstName: 'A', lastName: 'B' }, TEST_FILE);
    createUser({ provider: 'yandex', providerId: '42', firstName: 'C', lastName: 'D' }, TEST_FILE);
    const vk = findByProvider('vk', '42', TEST_FILE);
    const yandex = findByProvider('yandex', '42', TEST_FILE);
    expect(vk.firstName).toBe('A');
    expect(yandex.firstName).toBe('C');
    expect(vk.id).not.toBe(yandex.id);
  });

  test('createUser is idempotent — returns existing on duplicate provider+providerId', () => {
    const first = createUser({ provider: 'vk', providerId: '12345', firstName: 'I', lastName: 'P' }, TEST_FILE);
    const second = createUser({ provider: 'vk', providerId: '12345', firstName: 'I', lastName: 'P' }, TEST_FILE);
    expect(second.id).toBe(first.id);
    expect(getUsers(TEST_FILE)).toHaveLength(1);
  });

  test('findById returns user by uuid', () => {
    const created = createUser({ provider: 'vk', providerId: '77777', firstName: 'O', lastName: 'I' }, TEST_FILE);
    expect(findById(created.id, TEST_FILE)).toMatchObject({ providerId: '77777' });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npm test -- tests/services/users.test.js`
Expected: FAIL — `findByProvider is not a function` (or similar).

**Step 3: Rewrite users.js to satisfy the new contract**

Replace `server/src/services/users.js`:

```javascript
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, '../../data/users.json');

function getUsers(filePath = DEFAULT_FILE) {
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

function saveUsers(users, filePath = DEFAULT_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
}

function findById(id, filePath = DEFAULT_FILE) {
  return getUsers(filePath).find((u) => u.id === id) || null;
}

function findByProvider(provider, providerId, filePath = DEFAULT_FILE) {
  return (
    getUsers(filePath).find(
      (u) => u.provider === provider && u.providerId === String(providerId)
    ) || null
  );
}

function createUser(profile, filePath = DEFAULT_FILE) {
  const { provider, providerId, firstName, lastName, email, avatarId } = profile;
  const existing = findByProvider(provider, providerId, filePath);
  if (existing) return existing;

  const users = getUsers(filePath);
  const user = {
    id: crypto.randomUUID(),
    provider,
    providerId: String(providerId),
    firstName,
    lastName,
    ...(email ? { email } : {}),
    ...(avatarId ? { avatarId } : {}),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users, filePath);
  return user;
}

module.exports = { getUsers, findById, findByProvider, createUser };
```

**Step 4: Run tests, verify pass**

Run: `cd server && npm test -- tests/services/users.test.js`
Expected: 7 tests pass.

**Step 5: Stage and pause for review**

Run: `git add server/src/services/users.js server/tests/services/users.test.js`
Then **stop and let the user review/commit**.

---

### Task 2: Update VK route + its tests for new users schema

**Files:**
- Modify: `server/src/routes/auth.js:34` (the VK exchange handler — `createUser` call)
- Modify: `server/src/services/vk.js:62-65` (return shape from `fetchUserProfile`)
- Modify: `server/tests/routes/auth.test.js` (update mocks/expectations)

**Step 1: Update vk.js return shape**

In `server/src/services/vk.js`, change the `fetchUserProfile` return:

```javascript
return {
  vkId: parseInt(user.user_id, 10),  // remove this line
  firstName: user.first_name,
  lastName: user.last_name,
};
```

Replace the return with:

```javascript
return {
  provider: 'vk',
  providerId: String(user.user_id),
  firstName: user.first_name,
  lastName: user.last_name,
};
```

**Step 2: Update vk.test.js expectations**

In `server/tests/services/vk.test.js`, find the assertion that expects `vkId` in `fetchUserProfile`'s return, and update to:

```javascript
expect(result).toEqual({
  provider: 'vk',
  providerId: '12345',
  firstName: 'Ivan',
  lastName: 'Petrov',
});
```

**Step 3: Update auth.js to pass profile straight through**

In `server/src/routes/auth.js`, replace the `createUser(profile, usersFile)` call site so the JWT payload includes `provider/providerId`:

```javascript
const profile = await fetchUserProfile(accessToken, vkAppId, deviceId);
const user = createUser(profile, usersFile);

const token = jwt.sign(
  { userId: user.id, provider: user.provider, providerId: user.providerId },
  jwtSecret,
  { expiresIn: '7d' }
);
```

(Remove the `vkId` field from the JWT payload.)

**Step 4: Update auth.test.js mock returns + assertions**

In `server/tests/routes/auth.test.js`, change the `fetchUserProfile.mockResolvedValue(...)` to return the new shape:

```javascript
fetchUserProfile.mockResolvedValue({
  provider: 'vk',
  providerId: '12345',
  firstName: 'Ivan',
  lastName: 'Petrov',
});
```

Update any JWT assertion that expects `vkId` to expect `provider`/`providerId`.

**Step 5: Run all server tests**

Run: `cd server && npm test`
Expected: all VK tests pass, users tests pass.

**Step 6: Stage and pause for review**

Run: `git add server/src/services/vk.js server/src/routes/auth.js server/tests/services/vk.test.js server/tests/routes/auth.test.js`
Then **stop and let the user review/commit**.

---

### Task 3: Yandex service (TDD)

**Files:**
- Create: `server/src/services/yandex.js`
- Create: `server/tests/services/yandex.test.js`

**Step 1: Write failing tests**

Create `server/tests/services/yandex.test.js`:

```javascript
const { fetchUserProfile } = require('../../src/services/yandex');

global.fetch = jest.fn();

beforeEach(() => {
  fetch.mockReset();
});

describe('yandex service', () => {
  describe('fetchUserProfile', () => {
    test('GETs login.yandex.ru/info with OAuth header and returns mapped profile', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '1000034426',
          login: 'ivan',
          default_email: 'ivan@yandex.ru',
          default_avatar_id: '131652443',
          first_name: 'Ivan',
          last_name: 'Petrov',
          display_name: 'ivan',
        }),
      });

      const result = await fetchUserProfile('access-token-xyz');

      expect(fetch).toHaveBeenCalledWith(
        'https://login.yandex.ru/info?format=json',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'OAuth access-token-xyz',
          }),
        })
      );
      expect(result).toEqual({
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Ivan',
        lastName: 'Petrov',
        email: 'ivan@yandex.ru',
        avatarId: '131652443',
      });
    });

    test('omits email/avatarId when not granted in scopes', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '1000034426',
          login: 'ivan',
          first_name: 'Ivan',
          last_name: 'Petrov',
        }),
      });

      const result = await fetchUserProfile('token');
      expect(result).toMatchObject({
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Ivan',
        lastName: 'Petrov',
      });
      expect(result.email).toBeUndefined();
      expect(result.avatarId).toBeUndefined();
    });

    test('throws yandex_token_invalid on 401 response', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_token' }),
      });

      await expect(fetchUserProfile('bad-token')).rejects.toThrow(/yandex_token_invalid/);
    });

    test('throws yandex_unreachable on network error', async () => {
      fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
      await expect(fetchUserProfile('token')).rejects.toThrow(/yandex_unreachable/);
    });
  });
});
```

**Step 2: Run tests to verify failure**

Run: `cd server && npm test -- tests/services/yandex.test.js`
Expected: FAIL — `Cannot find module '../../src/services/yandex'`.

**Step 3: Create yandex.js**

Create `server/src/services/yandex.js`:

```javascript
async function fetchUserProfile(accessToken) {
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

  return {
    provider: 'yandex',
    providerId: String(data.id),
    firstName: data.first_name || '',
    lastName: data.last_name || '',
    ...(data.default_email ? { email: data.default_email } : {}),
    ...(data.default_avatar_id ? { avatarId: data.default_avatar_id } : {}),
  };
}

module.exports = { fetchUserProfile };
```

**Step 4: Run tests, verify pass**

Run: `cd server && npm test -- tests/services/yandex.test.js`
Expected: 4 tests pass.

**Step 5: Stage and pause for review**

Run: `git add server/src/services/yandex.js server/tests/services/yandex.test.js`
Then **stop and let the user review/commit**.

---

### Task 4: `/auth/yandex/exchange` route (TDD)

**Files:**
- Modify: `server/src/routes/auth.js`
- Create: `server/tests/routes/auth.yandex.test.js`

**Step 1: Write failing route tests**

Create `server/tests/routes/auth.yandex.test.js`:

```javascript
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { createAuthRoutes } = require('../../src/routes/auth');

const TEST_FILE = path.join(__dirname, '../../data/users.yandex-route-test.json');
const JWT_SECRET = 'test-secret';

jest.mock('../../src/services/yandex', () => ({
  fetchUserProfile: jest.fn(),
}));
const { fetchUserProfile } = require('../../src/services/yandex');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRoutes({
    jwtSecret: JWT_SECRET,
    vkAppId: '54501952',
    vkAppSecret: 'irrelevant',
    yandexAppId: 'yandex-client-abc',
    usersFile: TEST_FILE,
  }));
  return app;
}

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
  fetchUserProfile.mockReset();
});

afterAll(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('POST /auth/yandex/exchange', () => {
  test('returns 400 when access_token is missing', async () => {
    const res = await request(createApp())
      .post('/auth/yandex/exchange')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_fields');
  });

  test('returns JWT on valid token', async () => {
    fetchUserProfile.mockResolvedValueOnce({
      provider: 'yandex',
      providerId: '1000034426',
      firstName: 'Ivan',
      lastName: 'Petrov',
      email: 'ivan@yandex.ru',
    });

    const res = await request(createApp())
      .post('/auth/yandex/exchange')
      .send({ access_token: 'valid-token' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    const payload = jwt.verify(res.body.token, JWT_SECRET);
    expect(payload.provider).toBe('yandex');
    expect(payload.providerId).toBe('1000034426');
  });

  test('persists user to users.json on first login', async () => {
    fetchUserProfile.mockResolvedValueOnce({
      provider: 'yandex',
      providerId: '1000034426',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });

    await request(createApp()).post('/auth/yandex/exchange').send({ access_token: 'valid' });

    const users = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ provider: 'yandex', providerId: '1000034426' });
  });

  test('does not duplicate user on second login', async () => {
    fetchUserProfile.mockResolvedValue({
      provider: 'yandex',
      providerId: '1000034426',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });

    await request(createApp()).post('/auth/yandex/exchange').send({ access_token: 'first' });
    await request(createApp()).post('/auth/yandex/exchange').send({ access_token: 'second' });

    const users = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
    expect(users).toHaveLength(1);
  });

  test('returns 401 when token validation fails', async () => {
    fetchUserProfile.mockRejectedValueOnce(new Error('yandex_token_invalid: invalid_token'));

    const res = await request(createApp())
      .post('/auth/yandex/exchange')
      .send({ access_token: 'expired' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('yandex_token_invalid');
  });

  test('returns 502 when login.yandex.ru is unreachable', async () => {
    fetchUserProfile.mockRejectedValueOnce(new Error('yandex_unreachable: ENOTFOUND'));

    const res = await request(createApp())
      .post('/auth/yandex/exchange')
      .send({ access_token: 'token' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('yandex_unreachable');
  });
});
```

**Step 2: Run tests, verify failure**

Run: `cd server && npm test -- tests/routes/auth.yandex.test.js`
Expected: FAIL — route 404s or `yandexAppId` is unknown.

**Step 3: Update routes/auth.js**

In `server/src/routes/auth.js`, update the function signature and add the Yandex route:

```javascript
const express = require('express');
const jwt = require('jsonwebtoken');
const { exchangeCode, fetchUserProfile: fetchVKUserProfile } = require('../services/vk');
const { fetchUserProfile: fetchYandexUserProfile } = require('../services/yandex');
const { findById, createUser } = require('../services/users');
const { createAuthMiddleware } = require('../middleware/auth');

function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, usersFile }) {
  const router = express.Router();
  const authMiddleware = createAuthMiddleware(jwtSecret);

  // ... existing /vk/exchange handler unchanged from Task 2 ...

  router.post('/yandex/exchange', async (req, res) => {
    const { access_token: accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'access_token is required',
      });
    }

    try {
      const profile = await fetchYandexUserProfile(accessToken);
      const user = createUser(profile, usersFile);

      const token = jwt.sign(
        { userId: user.id, provider: user.provider, providerId: user.providerId },
        jwtSecret,
        { expiresIn: '7d' }
      );

      return res.json({ token });
    } catch (err) {
      const msg = err.message || '';
      if (msg.startsWith('yandex_token_invalid')) {
        return res.status(401).json({ error: 'yandex_token_invalid', message: msg });
      }
      if (msg.startsWith('yandex_unreachable')) {
        return res.status(502).json({ error: 'yandex_unreachable', message: msg });
      }
      return res.status(500).json({ error: 'internal_error', message: msg });
    }
  });

  router.get('/me', authMiddleware, (req, res) => {
    const user = findById(req.user.userId, usersFile);
    if (!user) {
      return res.status(401).json({ error: 'invalid_token', message: 'User not found' });
    }
    return res.json({ user });
  });

  return router;
}

module.exports = { createAuthRoutes };
```

**Step 4: Run all tests**

Run: `cd server && npm test`
Expected: all VK tests + Yandex tests pass.

**Step 5: Stage and pause for review**

Run: `git add server/src/routes/auth.js server/tests/routes/auth.yandex.test.js`
Then **stop**.

---

### Task 5: Wire env + index.js

**Files:**
- Modify: `server/.env`
- Modify: `server/src/index.js:27-32`

**Step 1: Add env var**

Append to `server/.env`:

```
YANDEX_CLIENT_ID=PLACEHOLDER_FILL_AFTER_TASK_8
```

**Step 2: Pass it to routes**

In `server/src/index.js`, update the `app.use('/auth', ...)` call:

```javascript
app.use('/auth', createAuthRoutes({
  jwtSecret: process.env.JWT_SECRET,
  vkAppId: process.env.VK_APP_ID,
  vkAppSecret: process.env.VK_APP_SECRET,
  yandexAppId: process.env.YANDEX_CLIENT_ID,
  usersFile,
}));
```

(`yandexAppId` isn't strictly used by the server today — token validation calls `login.yandex.ru/info` with just the bearer token — but plumbing it through now keeps the option open for future client-side asserts.)

**Step 3: Stage and pause for review**

Run: `git add server/.env server/src/index.js`
Then **stop**.

---

### Task 6: Wipe users.json + curl smoke test

**Files:**
- Modify: `server/data/users.json`

**Step 1: Wipe**

Run: `echo "[]" > server/data/users.json`

**Step 2: Start server**

Run (in separate terminal): `cd server && npm start`
Expected: `Server running on port 5173`.

**Step 3: Smoke-test the new route**

Run from another terminal:

```bash
# missing field
curl -s -X POST http://localhost:5173/auth/yandex/exchange \
  -H "Content-Type: application/json" -d '{}' | jq .
```
Expected: `{ "error": "missing_fields", ... }`, HTTP 400.

```bash
# invalid token
curl -s -X POST http://localhost:5173/auth/yandex/exchange \
  -H "Content-Type: application/json" -d '{"access_token":"definitely-not-a-real-token"}' | jq .
```
Expected: `{ "error": "yandex_token_invalid", ... }`, HTTP 401.

(A real-token end-to-end test happens in Task 21 once the mobile flow exists. We can also obtain a real token manually from `oauth.yandex.com` debug helpers if you want to test earlier — optional.)

**Step 4: Stop server, stage and pause for review**

Run: `git add server/data/users.json`
Then **stop**.

---

## Phase 2 — Yandex OAuth client registration (manual, external)

### Task 7: Get debug + release SHA-256 fingerprints

**Files:**
- (read only) `app-sdk/android/app/keystore` (or wherever the release keystore lives)

**Step 1: Find the keystore path**

Run: `ls app-sdk/android/app/*.keystore 2>/dev/null; ls app-sdk/android/app/*.jks 2>/dev/null`
If no release keystore exists yet, build one with `keytool -genkey -v -keystore app-sdk/android/app/release.keystore -alias appsdk -keyalg RSA -keysize 2048 -validity 10000` and **note the password**.

**Step 2: Print the debug SHA-256**

Default debug keystore lives at `~/.android/debug.keystore`, password `android`:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep "SHA256:"
```

Record the value — call it `DEBUG_SHA256`.

**Step 3: Print the release SHA-256**

```bash
keytool -list -v -keystore app-sdk/android/app/release.keystore -alias appsdk | grep "SHA256:"
```

Record the value — call it `RELEASE_SHA256`.

**Step 4: Pause** — these values go into Yandex registration in the next task.

---

### Task 8: Register Yandex OAuth client

**Files:** none — this is a browser/cabinet step.

**Step 1: Open Yandex OAuth cabinet**

Browse to: `https://oauth.yandex.com/client/new`

**Step 2: Fill the form**

- **Name:** `VK OAuth Demo (test)`
- **Platforms (check both):**
  - **Android app:**
    - Package name: `com.vkoauth.appsdk`
    - SHA-256 fingerprint: paste both `DEBUG_SHA256` and `RELEASE_SHA256` (one per line if the field accepts multiple).
  - **iOS app:**
    - AppId: `<TEAM_ID>.com.vkoauth.appsdk` (TEAM_ID can be a placeholder for now if no Apple Developer account is connected; iOS testing is deferred).
- **Scopes (check):**
  - `login:info`
  - `login:email`
  - `login:avatar`

**Step 3: Save and copy the `client_id`**

Copy the generated `client_id` (called "ID" in the cabinet — the OAuth `client_id`).

**Step 4: Update `.env`**

Replace `YANDEX_CLIENT_ID=PLACEHOLDER_FILL_AFTER_TASK_8` in `server/.env` with the real value.

Note: also remember the `client_id` for `app-sdk/app.json` plugin config in Task 16.

**Step 5: Stage and pause**

Run: `git add server/.env`
Then **stop**.

---

## Phase 3 — Native module: expo-yandex-sdk

> No automated tests in this phase — Expo native modules cannot be unit-tested without an emulator. End-to-end verification happens in Task 21.

### Task 9: Create module skeleton

**Files (all new):**
- `app-sdk/modules/expo-yandex-sdk/expo-module.config.json`
- `app-sdk/modules/expo-yandex-sdk/index.ts`
- `app-sdk/modules/expo-yandex-sdk/src/index.ts`
- `app-sdk/modules/expo-yandex-sdk/src/ExpoYandexSDK.types.ts`

**Step 1: expo-module.config.json**

```json
{
  "platforms": ["android", "ios"],
  "android": {
    "modules": ["expo.modules.yandexsdk.ExpoYandexSDKModule"]
  },
  "ios": {
    "modules": ["ExpoYandexSDKModule"]
  }
}
```

**Step 2: types**

`src/ExpoYandexSDK.types.ts`:

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

**Step 3: TS wrapper around native module**

`src/index.ts`:

```typescript
import { requireNativeModule } from "expo-modules-core";
import type { YandexAuthResult } from "./ExpoYandexSDK.types";

type ExpoYandexSDKNativeModule = {
  authorize(): Promise<YandexAuthResult>;
};

const ExpoYandexSDK =
  requireNativeModule<ExpoYandexSDKNativeModule>("ExpoYandexSDK");

export async function authorize(): Promise<YandexAuthResult> {
  return ExpoYandexSDK.authorize();
}
```

**Step 4: re-export at package root**

`index.ts`:

```typescript
export { authorize } from "./src";
export type {
  YandexAuthResult,
  YandexAuthSuccess,
  YandexAuthCancelled,
} from "./src/ExpoYandexSDK.types";
```

**Step 5: Stage and pause for review**

Run: `git add app-sdk/modules/expo-yandex-sdk/`
Then **stop**.

---

### Task 10: Android — gradle dependency + manifest

**Files (all new):**
- `app-sdk/modules/expo-yandex-sdk/android/build.gradle`
- `app-sdk/modules/expo-yandex-sdk/android/src/main/AndroidManifest.xml`

**Step 1: build.gradle**

`android/build.gradle`:

```gradle
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

group = 'expo.modules.yandexsdk'
version = '0.1.0'

def expoModulesCorePlugin = new File(project(":expo-modules-core").projectDir.absolutePath, "ExpoModulesCorePlugin.gradle")
apply from: expoModulesCorePlugin
applyKotlinExpoModulesCorePlugin()
useCoreDependencies()
useExpoPublishing()

android {
  namespace "expo.modules.yandexsdk"
  compileSdk safeExtGet("compileSdkVersion", 34)

  defaultConfig {
    minSdkVersion safeExtGet("minSdkVersion", 21)
    targetSdkVersion safeExtGet("targetSdkVersion", 34)
  }

  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
  }
}

dependencies {
  implementation "com.yandex.android:authsdk:3.2.0"
}
```

(Reference: copy structure from `app-sdk/modules/expo-vk-sdk/android/build.gradle` for any divergences specific to your local Expo modules-core version.)

**Step 2: empty manifest**

`android/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android" />
```

(The Yandex SDK ships its own internal `AuthSdkActivity` / `WebViewLoginActivity` — host app manifest needs no scheme / intent filter.)

**Step 3: Stage and pause**

Run: `git add app-sdk/modules/expo-yandex-sdk/android/`
Then **stop**.

---

### Task 11: Android Kotlin native module

**Files (new):**
- `app-sdk/modules/expo-yandex-sdk/android/src/main/java/expo/modules/yandexsdk/ExpoYandexSDKModule.kt`

**Step 1: write Kotlin module**

```kotlin
package expo.modules.yandexsdk

import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import com.yandex.authsdk.YandexAuthLoginOptions
import com.yandex.authsdk.YandexAuthOptions
import com.yandex.authsdk.YandexAuthResult
import com.yandex.authsdk.YandexAuthSdk
import com.yandex.authsdk.YandexAuthSdkContract
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class YandexAuthException(message: String) : CodedException("YANDEX_AUTH_ERROR", message, null)

class ExpoYandexSDKModule : Module() {
  private var pendingPromise: Promise? = null
  private var launcher: ActivityResultLauncher<YandexAuthLoginOptions>? = null
  private var sdk: YandexAuthSdk? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoYandexSDK")

    OnCreate {
      val activity = appContext.currentActivity as? androidx.activity.ComponentActivity
        ?: return@OnCreate
      val clientId = activity.applicationInfo.metaData?.getString("YandexClientID")
        ?: throw YandexAuthException("YandexClientID missing from manifest meta-data")

      val options = YandexAuthOptions(activity.applicationContext, clientId)
      sdk = YandexAuthSdk.create(options)

      launcher = activity.activityResultRegistry.register(
        "expo-yandex-sdk-auth",
        sdk!!.contract
      ) { result ->
        val promise = pendingPromise ?: return@register
        pendingPromise = null
        when (result) {
          is YandexAuthResult.Success -> {
            promise.resolve(mapOf(
              "accessToken" to result.token.value,
              "expiresIn" to result.token.expiresIn
            ))
          }
          is YandexAuthResult.Cancelled -> {
            promise.resolve(mapOf("cancelled" to true))
          }
          is YandexAuthResult.Failure -> {
            promise.reject(YandexAuthException(result.exception.message ?: "Unknown error"))
          }
        }
      }
    }

    AsyncFunction("authorize") { promise: Promise ->
      val activeLauncher = launcher
        ?: return@AsyncFunction promise.reject(YandexAuthException("SDK not initialized"))

      if (pendingPromise != null) {
        return@AsyncFunction promise.reject(YandexAuthException("Authorization already in progress"))
      }
      pendingPromise = promise
      activeLauncher.launch(YandexAuthLoginOptions())
    }
  }
}
```

**Note:** The `clientId` is read from manifest meta-data (`YandexClientID`), set later by `withYandexSDK.js` plugin (Task 15). This mirrors how `expo-vk-sdk` handles VK config.

**Step 2: Add `<meta-data>` placeholder**

In the same `AndroidManifest.xml` from Task 10, add an empty meta-data placeholder. Update to:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <meta-data android:name="YandexClientID" android:value="${YandexClientID}" />
  </application>
</manifest>
```

**Step 3: Stage and pause**

Run: `git add app-sdk/modules/expo-yandex-sdk/android/src/`
Then **stop**.

---

### Task 12: iOS — podspec + Swift module

**Files (new):**
- `app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDK.podspec`
- `app-sdk/modules/expo-yandex-sdk/ios/ExpoYandexSDKModule.swift`

**Step 1: podspec**

```ruby
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json'))) rescue {}

Pod::Spec.new do |s|
  s.name           = 'ExpoYandexSDK'
  s.version        = '0.1.0'
  s.summary        = 'Yandex ID SDK wrapper for Expo'
  s.author         = ''
  s.homepage       = 'https://github.com/your/repo'
  s.platforms      = { :ios => '13.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'YandexLoginSDK'

  s.swift_version  = '5.4'
  s.source_files = "**/*.{h,m,swift}"
end
```

**Step 2: Swift module skeleton**

`ios/ExpoYandexSDKModule.swift`:

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
        guard let rootVC = UIApplication.shared.windows.first?.rootViewController else {
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
      // Yandex SDK reports user cancellation via specific code; treat as cancelled
      if nsErr.domain == "YXLoginSDKErrorDomain" && nsErr.code == /* cancelled */ -2 {
        promise.resolve(["cancelled": true])
      } else {
        promise.reject("YANDEX_AUTH_ERROR", err.localizedDescription)
      }
    }
  }
}
```

**Note:** iOS won't be tested locally per user's preference. Mark this code as needing verification at the cloud-build step. The `-2` cancellation code is a placeholder — confirm against `YandexLoginSDK` headers when iOS testing happens.

**Step 3: Stage and pause**

Run: `git add app-sdk/modules/expo-yandex-sdk/ios/`
Then **stop**.

---

## Phase 4 — Plugin & app.json

### Task 13: withYandexSDK config plugin

**Files (new):**
- `app-sdk/plugins/withYandexSDK.js`

**Step 1: write the plugin**

```javascript
const {
  withAndroidManifest,
  withInfoPlist,
  AndroidConfig,
} = require("@expo/config-plugins");

function withYandexSDK(config, { clientId }) {
  if (!clientId) throw new Error("withYandexSDK: clientId is required");

  // Android: inject meta-data with the YandexClientID
  config = withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      "YandexClientID",
      clientId
    );
    return cfg;
  });

  // iOS: register yx<clientId> URL scheme + Info.plist YandexClientID
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

**Step 2: Stage and pause**

Run: `git add app-sdk/plugins/withYandexSDK.js`
Then **stop**.

---

### Task 14: Update app.json

**Files:**
- Modify: `app-sdk/app.json`

**Step 1: add plugin**

Add to the `"plugins"` array (replace `<YANDEX_CLIENT_ID>` with the value from Task 8):

```json
[
  "./plugins/withYandexSDK",
  { "clientId": "<YANDEX_CLIENT_ID>" }
]
```

**Step 2: Sanity-check the prebuild**

Run: `cd app-sdk && npx expo prebuild --no-install`
Expected: completes without errors. Check that `app-sdk/android/app/src/main/AndroidManifest.xml` now contains `<meta-data android:name="YandexClientID" android:value="<id>"/>` and `app-sdk/ios/<App>/Info.plist` contains `YandexClientID` and a `yx<id>` `CFBundleURLSchemes` entry.

**Step 3: Recreate `local.properties`** (per memory, after `--clean prebuild`):

```bash
echo 'sdk.dir=C\:\\Users\\Mukhtar\\AppData\\Local\\Android\\Sdk' > app-sdk/android/local.properties
```

**Step 4: Stage and pause**

Run: `git add app-sdk/app.json app-sdk/android/local.properties`
Then **stop**.

---

## Phase 5 — App UI

### Task 15: api.ts — exchangeYandexToken

**Files:**
- Modify: `app-sdk/src/services/api.ts`

**Step 1: add function**

Add to `app-sdk/src/services/api.ts`:

```typescript
export async function exchangeYandexToken(params: {
  accessToken: string;
}): Promise<{ token: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(`${API_URL}/auth/yandex/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: params.accessToken }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message || (body as any).error || "Yandex exchange failed");
  }

  return res.json();
}
```

**Step 2: Stage and pause**

Run: `git add app-sdk/src/services/api.ts`
Then **stop**.

---

### Task 16: useYandexAuth hook

**Files (new):**
- `app-sdk/src/hooks/useYandexAuth.ts`

**Step 1: write the hook**

```typescript
import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
import { exchangeYandexToken } from "../services/api";

export interface YandexAuthResult {
  token: string;
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
      const { token } = await exchangeYandexToken({ accessToken: result.accessToken });
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

**Step 2: Stage and pause**

Run: `git add app-sdk/src/hooks/useYandexAuth.ts`
Then **stop**.

---

### Task 17: login.tsx — add Yandex button

**Files:**
- Modify: `app-sdk/app/login.tsx`

**Step 1: import + use hook + render button**

Add imports:

```typescript
import { useYandexAuth } from "../src/hooks/useYandexAuth";
```

Inside the `LoginScreen` component, alongside the existing VK auth setup:

```typescript
const {
  authorize: yandexAuthorize,
  isLoading: yandexLoading,
  error: yandexError,
} = useYandexAuth(async ({ token }) => {
  await login({ token });
  router.replace("/home");
});

const isLoading = authLoading || vkLoading || yandexLoading;
const error = vkError || yandexError || authError;
```

Add a button in the JSX (place it after the VK button block):

```tsx
<Pressable
  style={[styles.yandexButton, isLoading && styles.buttonDisabled]}
  onPress={() => yandexAuthorize()}
  disabled={isLoading}
>
  {yandexLoading ? (
    <ActivityIndicator color="#fff" />
  ) : (
    <Text style={styles.buttonText}>Sign in with Yandex</Text>
  )}
</Pressable>
```

Add the style:

```typescript
yandexButton: {
  backgroundColor: "#FC3F1D",
  paddingHorizontal: 32,
  paddingVertical: 14,
  borderRadius: 8,
  minWidth: 200,
  alignItems: "center",
  marginTop: 12,
},
```

**Step 2: Stage and pause**

Run: `git add app-sdk/app/login.tsx`
Then **stop**.

---

## Phase 6 — Build & test

### Task 18: Build APK

**Step 1: Build**

```bash
cd app-sdk/android
JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot" ./gradlew assembleRelease
```

Expected: `BUILD SUCCESSFUL`. APK at `app-sdk/android/app/build/outputs/apk/release/app-release.apk`.

If build fails:
- "SDK location not found" → recreate `local.properties` (see Task 14 step 3).
- `com.yandex.android:authsdk` not found → confirm `mavenCentral()` is in the root `build.gradle` repositories (default for Expo).
- Kotlin compile error in `ExpoYandexSDKModule.kt` → check `safeExtGet`/`compileSdk` matches the value in other modules' build.gradle.

**Step 2: Install to device**

```bash
adb install -r app-sdk/android/app/build/outputs/apk/release/app-release.apk
```

**Step 3: Pause** for manual test in Task 21.

---

### Task 19: Run server with real Yandex client_id

**Step 1: Start the server**

```bash
cd server && npm start
```

Confirm `Server running on port 5173`.

**Step 2: Confirm `.env` has the real Yandex client_id**

Run: `grep YANDEX_CLIENT_ID server/.env`
Should show the real value, not `PLACEHOLDER_FILL_AFTER_TASK_8`.

(API_URL on the device side already points to `http://192.168.87.125:5173` per memory — confirm via `grep API_URL app-sdk/src/config.ts`.)

---

### Task 20: Manual device tests — three cases

**Case A — Yandex app installed** (the headline UX):

1. Install Yandex Browser (or Yandex Mail / Yandex Go / Yandex with Alisa) on the test device and log in to a Yandex account.
2. Open the app, tap "Sign in with Yandex".
3. Expect: the Yandex app opens, shows a "Confirm sign-in to <App name>" sheet, user taps Confirm.
4. Expect: returns to app, navigates to `/home`, user is logged in.
5. Verify on server: `tail server/data/users.json` shows a row with `provider: "yandex", providerId: "..."`.

**Case B — No Yandex app installed:**

1. Uninstall all Yandex apps from the device.
2. Open the app, tap "Sign in with Yandex".
3. Expect: a Chrome Custom Tab opens with `oauth.yandex.com/authorize?...`.
4. User enters Yandex credentials, taps Allow.
5. Expect: returns to app, navigates to `/home`.

**Case C — User cancels:**

1. Tap "Sign in with Yandex".
2. When the Yandex app sheet (or Custom Tab) opens, press the back button / close.
3. Expect: returns to app login screen with the button re-enabled, **no** error message.

**Step 4:** record outcomes in a test journal entry. If any case fails, do not proceed to Task 21 — open a debug iteration and fix.

---

### Task 21: VK regression check

**Step 1:** Wipe `users.json` again: `echo "[]" > server/data/users.json`.

**Step 2:** Tap "Sign in with VK". Expect VK SDK flow → `/home` → user persisted with `provider: "vk"`.

**Step 3:** Tap logout (if available) and try Yandex again. Both providers should produce separate user rows.

**Step 4:** Stage any pending changes (if test runs created log/debug files): `git status`, `git add -p`, **stop and let user commit**.

---

## Done state

- All Jest tests pass: `cd server && npm test` (existing VK + new Yandex + new users).
- APK builds without errors.
- All three manual test cases (A/B/C) pass on Android.
- VK login still works after the schema migration.
- iOS code present but untested locally — flagged for cloud build.

## Known follow-ups (not in this plan)

- iOS device testing in EAS cloud build.
- Adapt for the main app's GraphQL backend (`socialAuthCallback(provider, code, deviceId)` mutation): note that Yandex returns `access_token`, not `code`/`device_id` — the GraphQL schema may need a `socialAuthByToken(provider, accessToken)` mutation, or the test backend's `/auth/yandex/exchange` is a separate REST shim.
- Consider revoking the Yandex `access_token` after server-side validation by `POST https://oauth.yandex.com/revoke_token` to reduce token lifetime (currently we just discard it).
