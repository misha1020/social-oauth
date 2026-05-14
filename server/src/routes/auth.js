const express = require('express');
const jwt = require('jsonwebtoken');
const { exchangeCode, fetchUserProfile: fetchVKUserProfile } = require('../services/vk');
const { fetchUserProfile: fetchYandexUserProfile, verifyYandexJwt } = require('../services/yandex');
const { findById, createUser } = require('../services/users');
const { createAuthMiddleware } = require('../middleware/auth');

// vkAppSecret accepted for caller compatibility; not used — PKCE replaces client_secret in VK ID OAuth 2.1
// yandexAppId is plumbed for future client-side asserts; token validation uses the bearer token alone
function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, yandexAppId, yandexClientSecret, usersFile }) {
  const router = express.Router();
  const authMiddleware = createAuthMiddleware(jwtSecret);

  router.post('/vk/exchange', async (req, res) => {
    const { code, code_verifier: codeVerifier, device_id: deviceId } = req.body;

    if (!code || !codeVerifier || !deviceId) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'code, codeVerifier, and deviceId are required',
      });
    }

    try {
      const { accessToken } = await exchangeCode({
        code,
        codeVerifier,
        deviceId,
        redirectUri: `vk${vkAppId}://vk.ru/blank.html`,
        clientId: vkAppId,
      });

      const profile = await fetchVKUserProfile(accessToken, vkAppId, deviceId);
      const user = createUser(profile, usersFile);

      const token = jwt.sign(
        { userId: user.id, provider: user.provider, providerId: user.providerId },
        jwtSecret,
        { expiresIn: '7d' }
      );

      return res.json({ token });
    } catch (err) {
      return res.status(401).json({
        error: 'vk_exchange_failed',
        message: err.message || 'VK token exchange failed',
      });
    }
  });

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

  router.post('/yandex/exchange-jwt', async (req, res) => {
    const { jwt: yandexJwt } = req.body;

    if (!yandexJwt) {
      return res.status(400).json({ error: 'missing_fields', message: 'jwt is required' });
    }
    if (!yandexClientSecret) {
      return res.status(500).json({
        error: 'server_misconfigured',
        message: 'YANDEX_CLIENT_SECRET is not set',
      });
    }

    try {
      const { claims, keyEncoding } = verifyYandexJwt(yandexJwt, yandexClientSecret);

      // These two logs ARE the experiment's result — read them in the server console.
      console.log('[yandex-jwt] VERIFIED. key encoding =', keyEncoding);
      console.log('[yandex-jwt] claims =', JSON.stringify(claims, null, 2));

      // Map claims -> the profile shape createUser expects.
      // Field names confirmed against a live /info?format=jwt run (2026-05-14): the JWT
      // carries `uid`, a full `name` (+ `display_name`), `email`, and `avatar_id` — there is
      // NO first_name/last_name pair, so `name` is split on whitespace into first/last.
      const fullName = (claims.name || claims.display_name || '').trim();
      const [firstName, ...lastNameParts] = fullName.split(/\s+/);
      const profile = {
        provider: 'yandex',
        providerId: String(claims.uid),
        firstName: firstName || '',
        lastName: lastNameParts.join(' '),
        ...(claims.email ? { email: claims.email } : {}),
        ...(claims.avatar_id ? { avatarId: claims.avatar_id } : {}),
      };

      const user = createUser(profile, usersFile);
      const token = jwt.sign(
        { userId: user.id, provider: user.provider, providerId: user.providerId },
        jwtSecret,
        { expiresIn: '7d' }
      );

      // _debug echoed back so the result is visible on-device without the server console.
      return res.json({ token, _debug: { keyEncoding, claims } });
    } catch (err) {
      const msg = err.message || '';
      console.error('[yandex-jwt] FAILED:', msg);
      if (msg.startsWith('yandex_jwt_invalid')) {
        return res.status(401).json({ error: 'yandex_jwt_invalid', message: msg });
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
