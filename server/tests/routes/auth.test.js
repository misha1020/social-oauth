const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { createAuthRoutes } = require('../../src/routes/auth');

const TEST_FILE = path.join(__dirname, '../../data/users.route-test.json');
const JWT_SECRET = 'test-secret';

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
    vkAppId: '54501952',
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

describe('POST /auth/vk/exchange', () => {
  test('returns JWT token on valid code exchange', async () => {
    exchangeCode.mockResolvedValue({ accessToken: 'vk-token', userId: 12345, idToken: null });
    fetchUserProfile.mockResolvedValue({
      provider: 'vk',
      providerId: '12345',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });

    const app = createApp();
    const res = await request(app).post('/auth/vk/exchange').send({
      code: 'valid-code',
      code_verifier: 'test-verifier',
      device_id: 'test-device',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    const payload = jwt.verify(res.body.token, JWT_SECRET);
    expect(payload.provider).toBe('vk');
    expect(payload.providerId).toBe('12345');
  });

  test('returns 400 when fields are missing', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/vk/exchange').send({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_fields');
  });

  test('returns 401 when VK exchange fails', async () => {
    exchangeCode.mockRejectedValue(new Error('Code expired'));

    const app = createApp();
    const res = await request(app).post('/auth/vk/exchange').send({
      code: 'bad-code',
      code_verifier: 'verifier',
      device_id: 'device',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('vk_exchange_failed');
  });
});

describe('GET /auth/me', () => {
  test('returns user for valid token', async () => {
    exchangeCode.mockResolvedValue({ accessToken: 'vk-token', userId: 12345, idToken: null });
    fetchUserProfile.mockResolvedValue({
      provider: 'vk',
      providerId: '12345',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });

    const app = createApp();
    const exchangeRes = await request(app).post('/auth/vk/exchange').send({
      code: 'valid-code',
      code_verifier: 'verifier',
      device_id: 'device',
    });
    const { token } = exchangeRes.body;

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      provider: 'vk',
      providerId: '12345',
      firstName: 'Ivan',
    });
  });

  test('returns 401 for missing token', async () => {
    const app = createApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});
