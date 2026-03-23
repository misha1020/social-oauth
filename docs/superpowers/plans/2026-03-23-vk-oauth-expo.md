# VK OAuth Expo Android App — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working VK OAuth login flow for an Expo Android app backed by an Express server with file-based user storage and JWT auth.

**Architecture:** Two deployable units — `/server` (Express API with Docker) and `/app` (Expo Android with expo-auth-session + PKCE). The app gets an auth code from VK via system browser, sends it to the backend, which exchanges it for a VK token, creates/finds a user, and returns a JWT.

**Tech Stack:** Express (Node.js), jsonwebtoken, uuid, Jest (server tests), Expo SDK 52+, expo-auth-session, expo-web-browser, expo-secure-store, expo-router, TypeScript.

**Spec:** `docs/superpowers/specs/2026-03-23-vk-oauth-expo-design.md`

---

## File Structure

```
server/
  src/
    index.js              - Express entry point (middleware, routes, listen)
    routes/auth.js        - POST /auth/vk, GET /auth/me route handlers
    services/vk.js        - VK token exchange (calls id.vk.com)
    services/users.js     - File-based user CRUD (read/write users.json)
    middleware/auth.js     - JWT verification middleware
  data/
    users.json            - User storage file (empty array initially)
  tests/
    services/users.test.js   - User storage tests
    services/vk.test.js      - VK exchange tests (mocked HTTP)
    middleware/auth.test.js   - JWT middleware tests
    routes/auth.test.js      - Integration tests for auth endpoints
  package.json
  .env.example
  .gitignore
  Dockerfile
  docker-compose.yml

app/
  app.json                - Expo config (scheme: vkoauth, package name)
  package.json
  tsconfig.json
  app/
    _layout.tsx           - Root layout with auth state navigation
    index.tsx             - Redirects based on auth state
    login.tsx             - LoginScreen (VK sign-in button)
    home.tsx              - HomeScreen (profile + logout)
  src/
    services/api.ts       - Backend API calls (POST /auth/vk, GET /auth/me)
    hooks/useAuth.ts      - Auth state Context provider + useAuth hook
    hooks/useVKAuth.ts    - VK OAuth flow (useAuthRequest + promptAsync)
    config.ts             - API URL, VK client ID, TOKEN_KEY constants
```

---

## Chunk 1: Server

### Task 1: Initialize server project

**Files:**
- Create: `server/package.json`
- Create: `server/.gitignore`
- Create: `server/.env.example`
- Create: `server/data/users.json`

- [ ] **Step 1: Create server directory and package.json**

```bash
cd server
npm init -y
```

Then edit `package.json` to set:
```json
{
  "name": "vk-oauth-server",
  "version": "1.0.0",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express jsonwebtoken uuid dotenv cors
npm install -D jest
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
```

- [ ] **Step 4: Create .env.example**

```
VK_APP_ID=your_app_id
VK_APP_SECRET=your_app_secret
JWT_SECRET=random_secret_string
PORT=3000
```

- [ ] **Step 5: Create empty users.json**

```json
[]
```

- [ ] **Step 6: Create src/index.js placeholder**

```js
// Entry point — implemented in Task 6
```

- [ ] **Step 7: Verify test runner works**

Run: `cd server && npx jest --version`
Expected: Jest version number prints without error.

- [ ] **Step 8: Commit**

```bash
git add server/
git commit -m "feat(server): initialize Express project with dependencies"
```

---

### Task 2: User storage service (TDD)

**Files:**
- Create: `server/src/services/users.js`
- Create: `server/tests/services/users.test.js`

- [ ] **Step 1: Write failing tests for user storage**

`server/tests/services/users.test.js`:
```js
const path = require('path');
const fs = require('fs');
const { getUsers, findById, findByVkId, createUser } = require('../../src/services/users');

const TEST_FILE = path.join(__dirname, '../../data/users.test.json');

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
});

afterAll(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('users service', () => {
  test('getUsers returns empty array from empty file', () => {
    const users = getUsers(TEST_FILE);
    expect(users).toEqual([]);
  });

  test('createUser adds a user and returns it', () => {
    const user = createUser({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' }, TEST_FILE);
    expect(user).toMatchObject({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' });
    expect(user.id).toBeDefined();
    expect(user.createdAt).toBeDefined();

    const users = getUsers(TEST_FILE);
    expect(users).toHaveLength(1);
    expect(users[0].vkId).toBe(12345);
  });

  test('findByVkId returns existing user', () => {
    createUser({ vkId: 99999, firstName: 'Anna', lastName: 'Smirnova' }, TEST_FILE);
    const found = findByVkId(99999, TEST_FILE);
    expect(found).toMatchObject({ vkId: 99999, firstName: 'Anna' });
  });

  test('findByVkId returns null for unknown vkId', () => {
    const found = findByVkId(11111, TEST_FILE);
    expect(found).toBeNull();
  });

  test('findById returns existing user by id', () => {
    const created = createUser({ vkId: 77777, firstName: 'Oleg', lastName: 'Ivanov' }, TEST_FILE);
    const found = findById(created.id, TEST_FILE);
    expect(found).toMatchObject({ vkId: 77777, firstName: 'Oleg' });
  });

  test('findById returns null for unknown id', () => {
    const found = findById('nonexistent-id', TEST_FILE);
    expect(found).toBeNull();
  });

  test('createUser does not duplicate if vkId exists — returns existing', () => {
    const first = createUser({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' }, TEST_FILE);
    const second = createUser({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' }, TEST_FILE);
    expect(second.id).toBe(first.id);

    const users = getUsers(TEST_FILE);
    expect(users).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest tests/services/users.test.js`
Expected: FAIL — `Cannot find module '../../src/services/users'`

- [ ] **Step 3: Implement user storage service**

`server/src/services/users.js`:
```js
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_FILE = path.join(__dirname, '../../data/users.json');

function getUsers(filePath = DEFAULT_FILE) {
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

function saveUsers(users, filePath = DEFAULT_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
}

function findById(id, filePath = DEFAULT_FILE) {
  const users = getUsers(filePath);
  return users.find((u) => u.id === id) || null;
}

function findByVkId(vkId, filePath = DEFAULT_FILE) {
  const users = getUsers(filePath);
  return users.find((u) => u.vkId === vkId) || null;
}

function createUser({ vkId, firstName, lastName }, filePath = DEFAULT_FILE) {
  const existing = findByVkId(vkId, filePath);
  if (existing) return existing;

  const users = getUsers(filePath);
  const user = {
    id: uuidv4(),
    vkId,
    firstName,
    lastName,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users, filePath);
  return user;
}

module.exports = { getUsers, findById, findByVkId, createUser };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest tests/services/users.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/users.js server/tests/services/users.test.js
git commit -m "feat(server): add file-based user storage service with tests"
```

---

### Task 3: JWT auth middleware (TDD)

**Files:**
- Create: `server/src/middleware/auth.js`
- Create: `server/tests/middleware/auth.test.js`

- [ ] **Step 1: Write failing tests for JWT middleware**

`server/tests/middleware/auth.test.js`:
```js
const jwt = require('jsonwebtoken');
const { createAuthMiddleware } = require('../../src/middleware/auth');

const SECRET = 'test-secret';
const middleware = createAuthMiddleware(SECRET);

function mockReqResNext(authHeader) {
  const req = { headers: { authorization: authHeader } };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('auth middleware', () => {
  test('passes with valid token and sets req.user', () => {
    const token = jwt.sign({ userId: 'abc', vkId: 123 }, SECRET);
    const { req, res, next } = mockReqResNext(`Bearer ${token}`);

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ userId: 'abc', vkId: 123 });
  });

  test('rejects missing Authorization header', () => {
    const { req, res, next } = mockReqResNext(undefined);

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_token' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects expired token', () => {
    const token = jwt.sign({ userId: 'abc', vkId: 123, iat: Math.floor(Date.now() / 1000) - 100 }, SECRET, { expiresIn: '1s' });
    const { req, res, next } = mockReqResNext(`Bearer ${token}`);

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects token with wrong secret', () => {
    const token = jwt.sign({ userId: 'abc', vkId: 123 }, 'wrong-secret');
    const { req, res, next } = mockReqResNext(`Bearer ${token}`);

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest tests/middleware/auth.test.js`
Expected: FAIL — `Cannot find module '../../src/middleware/auth'`

- [ ] **Step 3: Implement JWT middleware**

`server/src/middleware/auth.js`:
```js
const jwt = require('jsonwebtoken');

function createAuthMiddleware(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'invalid_token', message: 'Token is invalid or expired' });
    }

    const token = header.slice(7);
    try {
      const payload = jwt.verify(token, secret);
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid_token', message: 'Token is invalid or expired' });
    }
  };
}

module.exports = { createAuthMiddleware };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest tests/middleware/auth.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/auth.js server/tests/middleware/auth.test.js
git commit -m "feat(server): add JWT auth middleware with tests"
```

---

### Task 4: VK token exchange service (TDD)

**Files:**
- Create: `server/src/services/vk.js`
- Create: `server/tests/services/vk.test.js`

- [ ] **Step 1: Write failing tests for VK exchange (mocked HTTP)**

`server/tests/services/vk.test.js`:
```js
const { exchangeCode, fetchUserProfile } = require('../../src/services/vk');

// Mock global fetch
global.fetch = jest.fn();

beforeEach(() => {
  fetch.mockReset();
});

describe('vk service', () => {
  describe('exchangeCode', () => {
    test('returns tokens on successful exchange', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'vk-access-token',
          user_id: 12345,
          id_token: 'some-id-token',
        }),
      });

      const result = await exchangeCode({
        code: 'auth-code',
        codeVerifier: 'verifier',
        deviceId: 'device-123',
        redirectUri: 'vkoauth://auth/vk',
        clientId: 'app-id',
        clientSecret: 'app-secret',
      });

      expect(result).toEqual({
        accessToken: 'vk-access-token',
        userId: 12345,
        idToken: 'some-id-token',
      });

      // Verify fetch was called with correct URL and form body
      expect(fetch).toHaveBeenCalledWith(
        'https://id.vk.com/oauth2/auth',
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('throws on VK error response', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Code expired',
        }),
      });

      await expect(
        exchangeCode({
          code: 'bad-code',
          codeVerifier: 'verifier',
          deviceId: 'device-123',
          redirectUri: 'vkoauth://auth/vk',
          clientId: 'app-id',
          clientSecret: 'app-secret',
        })
      ).rejects.toThrow('Code expired');
    });
  });

  describe('fetchUserProfile', () => {
    test('returns user profile from VK ID user_info endpoint', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            user_id: '12345',
            first_name: 'Ivan',
            last_name: 'Petrov',
          },
        }),
      });

      const profile = await fetchUserProfile('vk-access-token', 'test-client-id');
      expect(profile).toEqual({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest tests/services/vk.test.js`
Expected: FAIL — `Cannot find module '../../src/services/vk'`

- [ ] **Step 3: Implement VK service**

`server/src/services/vk.js`:
```js
async function exchangeCode({ code, codeVerifier, deviceId, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    device_id: deviceId,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://id.vk.com/oauth2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return {
    accessToken: data.access_token,
    userId: data.user_id,
    idToken: data.id_token,
  };
}

async function fetchUserProfile(accessToken, clientId) {
  const body = new URLSearchParams({
    access_token: accessToken,
    client_id: clientId,
  });

  const res = await fetch('https://id.vk.com/oauth2/user_info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();
  const user = data.user;

  return {
    vkId: Number(user.user_id),
    firstName: user.first_name,
    lastName: user.last_name,
  };
}

module.exports = { exchangeCode, fetchUserProfile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest tests/services/vk.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/vk.js server/tests/services/vk.test.js
git commit -m "feat(server): add VK token exchange service with tests"
```

---

### Task 5: Auth route handlers (TDD)

**Files:**
- Create: `server/src/routes/auth.js`
- Create: `server/tests/routes/auth.test.js`

- [ ] **Step 1: Install supertest for HTTP testing**

```bash
cd server && npm install -D supertest
```

- [ ] **Step 2: Write failing tests for auth routes**

`server/tests/routes/auth.test.js`:
```js
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { createAuthRoutes } = require('../../src/routes/auth');

const TEST_FILE = path.join(__dirname, '../../data/users.route-test.json');
const JWT_SECRET = 'test-secret';

// Mock VK service
jest.mock('../../src/services/vk', () => ({
  exchangeCode: jest.fn(),
  fetchUserProfile: jest.fn(),
}));

const { exchangeCode, fetchUserProfile } = require('../../src/services/vk');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRoutes({
    jwtSecret: JWT_SECRET,
    vkAppId: 'test-app-id',
    vkAppSecret: 'test-app-secret',
    usersFile: TEST_FILE,
  }));
  return app;
}

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
  exchangeCode.mockReset();
  fetchUserProfile.mockReset();
});

afterAll(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('POST /auth/vk', () => {
  test('returns 400 when fields are missing', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/vk').send({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_fields');
  });

  test('returns token and user on success', async () => {
    exchangeCode.mockResolvedValue({
      accessToken: 'vk-token',
      userId: 12345,
      idToken: null,
    });
    fetchUserProfile.mockResolvedValue({
      vkId: 12345,
      firstName: 'Ivan',
      lastName: 'Petrov',
    });

    const app = createApp();
    const res = await request(app).post('/auth/vk').send({
      code: 'auth-code',
      codeVerifier: 'verifier',
      deviceId: 'device-123',
      redirectUri: 'vkoauth://auth/vk',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toMatchObject({ vkId: 12345, firstName: 'Ivan' });

    // Verify JWT is valid
    const payload = jwt.verify(res.body.token, JWT_SECRET);
    expect(payload.vkId).toBe(12345);
  });

  test('returns 401 when VK exchange fails', async () => {
    exchangeCode.mockRejectedValue(new Error('Code expired'));

    const app = createApp();
    const res = await request(app).post('/auth/vk').send({
      code: 'bad-code',
      codeVerifier: 'verifier',
      deviceId: 'device-123',
      redirectUri: 'vkoauth://auth/vk',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('vk_exchange_failed');
  });
});

describe('GET /auth/me', () => {
  test('returns user for valid token', async () => {
    // Seed a user
    exchangeCode.mockResolvedValue({ accessToken: 'vk-token', userId: 12345, idToken: null });
    fetchUserProfile.mockResolvedValue({ vkId: 12345, firstName: 'Ivan', lastName: 'Petrov' });

    const app = createApp();
    const loginRes = await request(app).post('/auth/vk').send({
      code: 'code',
      codeVerifier: 'verifier',
      deviceId: 'device',
      redirectUri: 'vkoauth://auth/vk',
    });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ vkId: 12345, firstName: 'Ivan' });
  });

  test('returns 401 for missing token', async () => {
    const app = createApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx jest tests/routes/auth.test.js`
Expected: FAIL — `Cannot find module '../../src/routes/auth'`

- [ ] **Step 4: Implement auth routes**

`server/src/routes/auth.js`:
```js
const express = require('express');
const jwt = require('jsonwebtoken');
const { exchangeCode, fetchUserProfile } = require('../services/vk');
const { findById, createUser } = require('../services/users');
const { createAuthMiddleware } = require('../middleware/auth');

function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, usersFile }) {
  const router = express.Router();
  const authMiddleware = createAuthMiddleware(jwtSecret);

  router.post('/vk', async (req, res) => {
    const { code, codeVerifier, deviceId, redirectUri } = req.body;

    if (!code || !codeVerifier || !deviceId || !redirectUri) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'code, codeVerifier, deviceId, redirectUri are required',
      });
    }

    try {
      const { accessToken } = await exchangeCode({
        code,
        codeVerifier,
        deviceId,
        redirectUri,
        clientId: vkAppId,
        clientSecret: vkAppSecret,
      });

      const profile = await fetchUserProfile(accessToken, vkAppId);
      const user = createUser(profile, usersFile);

      const token = jwt.sign(
        { userId: user.id, vkId: user.vkId },
        jwtSecret,
        { expiresIn: '7d' }
      );

      return res.json({ token, user });
    } catch (err) {
      if (err.message && (err.message.includes('VK') || err.message.includes('expired') || err.message.includes('invalid'))) {
        return res.status(401).json({
          error: 'vk_exchange_failed',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Internal server error',
      });
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx jest tests/routes/auth.test.js`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/auth.js server/tests/routes/auth.test.js
git commit -m "feat(server): add auth route handlers with tests"
```

---

### Task 6: Express server entry point

**Files:**
- Modify: `server/src/index.js`

- [ ] **Step 1: Implement server entry point**

`server/src/index.js`:
```js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createAuthRoutes } = require('./routes/auth');

const app = express();

app.use(cors());
app.use(express.json());

const usersFile = path.join(__dirname, '../data/users.json');

// Ensure users.json exists
if (!fs.existsSync(usersFile)) {
  fs.mkdirSync(path.dirname(usersFile), { recursive: true });
  fs.writeFileSync(usersFile, '[]');
}

app.use('/auth', createAuthRoutes({
  jwtSecret: process.env.JWT_SECRET,
  vkAppId: process.env.VK_APP_ID,
  vkAppSecret: process.env.VK_APP_SECRET,
  usersFile,
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

- [ ] **Step 2: Run all server tests**

Run: `cd server && npx jest`
Expected: All tests pass (18 total: 7 users + 4 middleware + 3 vk + 4 routes).

- [ ] **Step 3: Commit**

```bash
git add server/src/index.js
git commit -m "feat(server): add Express entry point"
```

---

### Task 7: Docker setup

**Files:**
- Create: `server/Dockerfile`
- Create: `server/docker-compose.yml`

- [ ] **Step 1: Create Dockerfile**

`server/Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
EXPOSE 3000
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Create docker-compose.yml**

`server/docker-compose.yml`:
```yaml
services:
  vk-oauth-server:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

- [ ] **Step 3: Verify Docker build works**

Run: `cd server && docker build -t vk-oauth-server .`
Expected: Image builds successfully.

- [ ] **Step 4: Commit**

```bash
git add server/Dockerfile server/docker-compose.yml
git commit -m "feat(server): add Docker setup"
```

---

## Chunk 2: Mobile App

### Task 8: Initialize Expo project

**Files:**
- Create: `app/` (entire Expo project scaffold)

- [ ] **Step 1: Create Expo project**

```bash
cd c:/Work/antonov-media/vk-oauth
npx create-expo-app@latest app --template blank-typescript
```

- [ ] **Step 2: Install dependencies**

```bash
cd app
npx expo install expo-auth-session expo-web-browser expo-secure-store expo-router expo-constants expo-status-bar react-native-safe-area-context react-native-screens
```

- [ ] **Step 3: Configure app.json**

Edit `app/app.json` to include:
```json
{
  "expo": {
    "name": "VK OAuth Demo",
    "slug": "vk-oauth-demo",
    "scheme": "vkoauth",
    "version": "1.0.0",
    "platforms": ["android"],
    "android": {
      "package": "com.vkoauth.app",
      "adaptiveIcon": {
        "backgroundColor": "#ffffff"
      }
    },
    "plugins": ["expo-router", "expo-secure-store"]
  }
}
```

- [ ] **Step 4: Configure package.json for expo-router**

Add to `app/package.json`:
```json
{
  "main": "expo-router/entry"
}
```

- [ ] **Step 5: Create tsconfig.json**

`app/tsconfig.json`:
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add app/
git commit -m "feat(app): initialize Expo project with dependencies"
```

---

### Task 9: App config and API service

**Files:**
- Create: `app/src/config.ts`
- Create: `app/src/services/api.ts`

- [ ] **Step 1: Create config**

`app/src/config.ts`:
```ts
export const API_URL = 'https://mz.ludentes.ru';
export const VK_CLIENT_ID = 'YOUR_VK_APP_ID'; // Replace with actual app_id
export const TOKEN_KEY = 'auth_token';
```

- [ ] **Step 2: Create API service**

`app/src/services/api.ts`:
```ts
import { API_URL } from '../config';

interface AuthResponse {
  token: string;
  user: {
    id: string;
    vkId: number;
    firstName: string;
    lastName: string;
  };
}

interface MeResponse {
  user: {
    id: string;
    vkId: number;
    firstName: string;
    lastName: string;
  };
}

export async function loginWithVK(params: {
  code: string;
  codeVerifier: string;
  deviceId: string;
  redirectUri: string;
}): Promise<AuthResponse> {
  const res = await fetch(`${API_URL}/auth/vk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.message || 'Login failed');
  }

  return res.json();
}

export async function getMe(token: string): Promise<MeResponse> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error('Invalid token');
  }

  return res.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/config.ts app/src/services/api.ts
git commit -m "feat(app): add config and API service"
```

---

### Task 10: VK auth hook

**Files:**
- Create: `app/src/hooks/useVKAuth.ts`

- [ ] **Step 1: Create VK auth hook**

`app/src/hooks/useVKAuth.ts`:
```ts
import { useEffect, useRef } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri, useAuthRequest } from 'expo-auth-session';
import { VK_CLIENT_ID } from '../config';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://id.vk.com/authorize',
  tokenEndpoint: 'https://id.vk.com/oauth2/auth',
};

export interface VKAuthResult {
  code: string;
  codeVerifier: string;
  deviceId: string;
  redirectUri: string;
}

export function useVKAuth(onSuccess: (result: VKAuthResult) => void) {
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const redirectUri = makeRedirectUri({
    scheme: 'vkoauth',
    path: 'auth/vk',
  });

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: VK_CLIENT_ID,
      scopes: ['email', 'profile'],
      redirectUri,
      usePKCE: true,
      responseType: 'code',
    },
    discovery
  );

  useEffect(() => {
    if (response?.type === 'success' && request?.codeVerifier) {
      const { code, device_id } = response.params;
      onSuccessRef.current({
        code,
        codeVerifier: request.codeVerifier,
        deviceId: device_id || '',
        redirectUri,
      });
    }
  }, [response, request, redirectUri]);

  return {
    promptAsync,
    isReady: !!request,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/hooks/useVKAuth.ts
git commit -m "feat(app): add VK auth hook with PKCE"
```

---

### Task 11: Auth state hook

**Files:**
- Create: `app/src/hooks/useAuth.ts`

- [ ] **Step 1: Create auth state hook**

`app/src/hooks/useAuth.ts`:
```ts
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { loginWithVK, getMe } from '../services/api';
import { TOKEN_KEY } from '../config';

interface User {
  id: string;
  vkId: number;
  firstName: string;
  lastName: string;
}

interface AuthState {
  isLoading: boolean;
  isLoggedIn: boolean;
  user: User | null;
  error: string | null;
  login: (params: {
    code: string;
    codeVerifier: string;
    deviceId: string;
    redirectUri: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useAuthProvider() {
  const [state, setState] = useState<Omit<AuthState, 'login' | 'logout'>>({
    isLoading: true,
    isLoggedIn: false,
    user: null,
    error: null,
  });

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (!token) {
        setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
        return;
      }

      const { user } = await getMe(token);
      setState({ isLoading: false, isLoggedIn: true, user, error: null });
    } catch {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
    }
  }

  const login = useCallback(async (params: {
    code: string;
    codeVerifier: string;
    deviceId: string;
    redirectUri: string;
  }) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const { token, user } = await loginWithVK(params);
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      setState({ isLoading: false, isLoggedIn: true, user, error: null });
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err.message || 'Login failed',
      }));
    }
  }, []);

  const logout = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
  }, []);

  return { ...state, login, logout };
}

export { AuthContext };
```

**Note:** `AuthContext` and `useAuthProvider` are consumed in `_layout.tsx` (Task 13) to provide a single shared auth state across all screens.
```

- [ ] **Step 2: Commit**

```bash
git add app/src/hooks/useAuth.ts
git commit -m "feat(app): add auth state management hook"
```

---

### Task 12: Screens — LoginScreen and HomeScreen

**Files:**
- Create: `app/app/login.tsx`
- Create: `app/app/home.tsx`

- [ ] **Step 1: Create LoginScreen**

`app/app/login.tsx`:
```tsx
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useVKAuth } from '../src/hooks/useVKAuth';
import { useAuth } from '../src/hooks/useAuth';
import { router } from 'expo-router';

export default function LoginScreen() {
  const { login, isLoading, error } = useAuth();

  const { promptAsync, isReady } = useVKAuth(async (result) => {
    await login(result);
    router.replace('/home');
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>VK OAuth Demo</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.button, (!isReady || isLoading) && styles.buttonDisabled]}
        onPress={() => promptAsync()}
        disabled={!isReady || isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in with VK</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#4680C2',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: 'red',
    marginBottom: 16,
  },
});
```

- [ ] **Step 2: Create HomeScreen**

`app/app/home.tsx`:
```tsx
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useAuth } from '../src/hooks/useAuth';
import { router } from 'expo-router';

export default function HomeScreen() {
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome!</Text>

      {user && (
        <View style={styles.profile}>
          <Text style={styles.name}>{user.firstName} {user.lastName}</Text>
          <Text style={styles.info}>VK ID: {user.vkId}</Text>
          <Text style={styles.info}>User ID: {user.id}</Text>
        </View>
      )}

      <Pressable style={styles.button} onPress={handleLogout}>
        <Text style={styles.buttonText}>Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  profile: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    width: '100%',
    marginBottom: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  name: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  info: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  button: {
    backgroundColor: '#e53935',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add app/app/login.tsx app/app/home.tsx
git commit -m "feat(app): add LoginScreen and HomeScreen"
```

---

### Task 13: Root layout and navigation

**Files:**
- Create: `app/app/_layout.tsx`
- Create: `app/app/index.tsx`

- [ ] **Step 1: Create root layout with AuthProvider**

`app/app/_layout.tsx`:
```tsx
import { Stack } from 'expo-router';
import { AuthContext, useAuthProvider } from '../src/hooks/useAuth';

export default function RootLayout() {
  const auth = useAuthProvider();

  return (
    <AuthContext.Provider value={auth}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="home" />
      </Stack>
    </AuthContext.Provider>
  );
}
```

This ensures a single auth state is shared across all screens — no duplicate API calls or race conditions.

- [ ] **Step 2: Create index redirect**

`app/app/index.tsx`:
```tsx
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../src/hooks/useAuth';

export default function IndexScreen() {
  const { isLoading, isLoggedIn } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      router.replace(isLoggedIn ? '/home' : '/login');
    }
  }, [isLoading, isLoggedIn]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator size="large" />
    </View>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/app/_layout.tsx app/app/index.tsx
git commit -m "feat(app): add root layout and auth-based navigation"
```

---

## Chunk 3: Build & Test

### Task 14: Expo prebuild and manual test

- [ ] **Step 1: Run Expo prebuild**

```bash
cd app && npx expo prebuild --platform android
```

This generates the `android/` directory with native code configured for the `vkoauth` scheme.

- [ ] **Step 2: Set actual VK_CLIENT_ID in config**

Edit `app/src/config.ts` — replace `'YOUR_VK_APP_ID'` with the real app_id from VK ID cabinet.

- [ ] **Step 3: Create server .env file**

```bash
cd server
cp .env.example .env
```

Edit `.env` with actual VK credentials and a random JWT_SECRET.

- [ ] **Step 4: Start server locally for initial testing**

```bash
cd server && node src/index.js
```

Verify: `curl http://localhost:3000/health` returns `{"status":"ok"}`

- [ ] **Step 5: Build and run Android app**

Open `app/android/` in Android Studio, build and run on emulator or device.

Test the full flow:
1. App shows loading spinner → redirects to login
2. Tap "Sign in with VK" → system browser opens VK auth page
3. Log in with VK → redirected back to app
4. App shows HomeScreen with user name and VK ID
5. Tap Logout → returns to LoginScreen
6. Reopen app → still logged in (JWT persisted)

- [ ] **Step 6: Deploy server via Docker**

```bash
cd server && docker compose up -d --build
```

Verify: `curl https://mz.ludentes.ru/health` returns `{"status":"ok"}`

- [ ] **Step 7: Update app config to production URL**

Ensure `app/src/config.ts` has `API_URL = 'https://mz.ludentes.ru'` (already set in the plan).

- [ ] **Step 8: Rebuild and test against production server**

Rebuild Android app, test the full flow against the deployed backend.

- [ ] **Step 9: Commit any final adjustments**

```bash
git add -A
git commit -m "feat: finalize VK OAuth integration"
```
