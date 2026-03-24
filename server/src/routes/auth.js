const express = require('express');
const jwt = require('jsonwebtoken');
const { exchangeCode, fetchUserProfile } = require('../services/vk');
const { findById, createUser } = require('../services/users');
const { createAuthMiddleware } = require('../middleware/auth');

function createAuthRoutes({ jwtSecret, vkAppId, vkAppSecret, usersFile }) {
  const router = express.Router();
  const authMiddleware = createAuthMiddleware(jwtSecret);

  router.post('/vk', async (req, res) => {
    const { code, redirectUri } = req.body;

    if (!code || !redirectUri) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'code and redirectUri are required',
      });
    }

    try {
      const { accessToken } = await exchangeCode({
        code,
        redirectUri,
        clientId: vkAppId,
        clientSecret: vkAppSecret,
      });

      const profile = await fetchUserProfile(accessToken);
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
