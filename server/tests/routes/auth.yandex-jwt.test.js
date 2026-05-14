const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { createAuthRoutes } = require('../../src/routes/auth');

const TEST_FILE = path.join(__dirname, '../../data/users.yandex-jwt-route-test.json');
const JWT_SECRET = 'test-secret';
const CLIENT_SECRET = 'test-client-secret';

jest.mock('../../src/services/yandex', () => ({
  verifyYandexJwt: jest.fn(),
}));
const { verifyYandexJwt } = require('../../src/services/yandex');

// createApp({ withSecret: false }) omits yandexClientSecret to exercise the
// server_misconfigured branch.
function createApp({ withSecret = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRoutes({
    jwtSecret: JWT_SECRET,
    vkAppId: '54501952',
    vkAppSecret: 'irrelevant',
    ...(withSecret ? { yandexClientSecret: CLIENT_SECRET } : {}),
    usersFile: TEST_FILE,
  }));
  return app;
}

let logSpy;
let errorSpy;

beforeAll(() => {
  // The route console.log/console.error its result — silence it for clean test output.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
  verifyYandexJwt.mockReset();
});

describe('POST /auth/yandex/exchange-jwt', () => {
  test('returns 400 missing_fields when jwt is absent', async () => {
    const res = await request(createApp()).post('/auth/yandex/exchange-jwt').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_fields');
    expect(verifyYandexJwt).not.toHaveBeenCalled();
  });

  test('returns 500 server_misconfigured when YANDEX_CLIENT_SECRET is not set', async () => {
    const res = await request(createApp({ withSecret: false }))
      .post('/auth/yandex/exchange-jwt')
      .send({ jwt: 'any-token' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_misconfigured');
    expect(verifyYandexJwt).not.toHaveBeenCalled();
  });

  test('returns 401 yandex_jwt_invalid when no key encoding verifies', async () => {
    verifyYandexJwt.mockImplementationOnce(() => {
      throw new Error('yandex_jwt_invalid: no key encoding verified [utf8: invalid signature]');
    });

    const res = await request(createApp())
      .post('/auth/yandex/exchange-jwt')
      .send({ jwt: 'bad-token' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('yandex_jwt_invalid');
    expect(verifyYandexJwt).toHaveBeenCalledWith('bad-token', CLIENT_SECRET);
  });

  test('returns 500 internal_error on an unexpected verify failure', async () => {
    verifyYandexJwt.mockImplementationOnce(() => {
      throw new Error('something unexpected');
    });

    const res = await request(createApp())
      .post('/auth/yandex/exchange-jwt')
      .send({ jwt: 'token' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  test('returns an app JWT and persists the user on a verified token', async () => {
    verifyYandexJwt.mockReturnValueOnce({
      keyEncoding: 'utf8',
      claims: {
        uid: 1000034426,
        name: 'Ivan Petrov',
        email: 'ivan@yandex.ru',
        avatar_id: 'avatar-xyz',
      },
    });

    const res = await request(createApp())
      .post('/auth/yandex/exchange-jwt')
      .send({ jwt: 'valid-yandex-jwt' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body._debug.keyEncoding).toBe('utf8');

    const payload = jwt.verify(res.body.token, JWT_SECRET);
    expect(payload.provider).toBe('yandex');
    expect(payload.providerId).toBe('1000034426');

    const users = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      provider: 'yandex',
      providerId: '1000034426',
      firstName: 'Ivan',
      lastName: 'Petrov',
      email: 'ivan@yandex.ru',
    });
  });

  test('does not duplicate the user on a second login', async () => {
    verifyYandexJwt.mockReturnValue({
      keyEncoding: 'utf8',
      claims: { uid: 1000034426, name: 'Ivan Petrov' },
    });

    await request(createApp()).post('/auth/yandex/exchange-jwt').send({ jwt: 'first' });
    await request(createApp()).post('/auth/yandex/exchange-jwt').send({ jwt: 'second' });

    const users = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
    expect(users).toHaveLength(1);
  });
});
