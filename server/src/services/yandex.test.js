const jwt = require('jsonwebtoken');
const { verifyYandexJwt } = require('./yandex');

describe('verifyYandexJwt', () => {
  const secret = 'test-secret-utf8';

  test('verifies an HS256 token signed with the utf8 secret', () => {
    const token = jwt.sign({ uid: '123', first_name: 'Ann' }, secret, { algorithm: 'HS256' });
    const { claims, keyEncoding } = verifyYandexJwt(token, secret);
    expect(keyEncoding).toBe('utf8');
    expect(claims.uid).toBe('123');
    expect(claims.first_name).toBe('Ann');
  });

  test('throws yandex_jwt_invalid for a token signed with the wrong key', () => {
    const token = jwt.sign({ uid: '123' }, 'a-completely-different-secret', { algorithm: 'HS256' });
    expect(() => verifyYandexJwt(token, secret)).toThrow(/yandex_jwt_invalid/);
  });

  test('rejects an alg:none token (alg-confusion guard)', () => {
    // jsonwebtoken refuses to sign with 'none', so build the unsigned token by hand.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ uid: '123' })).toString('base64url');
    const unsignedToken = `${header}.${payload}.`;
    expect(() => verifyYandexJwt(unsignedToken, secret)).toThrow(/yandex_jwt_invalid/);
  });
});
