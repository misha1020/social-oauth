const jwt = require('jsonwebtoken');

// Yandex signs the /info?format=jwt token with HS256. The key is ASSUMED to be the app's
// client_secret, but the exact byte encoding isn't documented. Try the common ones and
// report which verified — that report is one of the experiment's findings.
function verifyYandexJwt(token, clientSecret) {
  const candidates = [
    { encoding: 'utf8', key: clientSecret },
    { encoding: 'base64', key: Buffer.from(clientSecret, 'base64') },
    { encoding: 'hex', key: Buffer.from(clientSecret, 'hex') },
  ];
  const errors = [];
  for (const { encoding, key } of candidates) {
    try {
      const claims = jwt.verify(token, key, { algorithms: ['HS256'] });
      return { claims, keyEncoding: encoding };
    } catch (e) {
      errors.push(`${encoding}: ${e.message}`);
    }
  }
  throw new Error(`yandex_jwt_invalid: no key encoding verified [${errors.join(' | ')}]`);
}

module.exports = { verifyYandexJwt };
