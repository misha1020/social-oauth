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
