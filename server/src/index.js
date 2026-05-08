require('dotenv').config();

process.on('exit', (code) => console.log('[diag] process.exit code=', code));
process.on('uncaughtException', (e) => console.error('[diag] uncaughtException:', e));
process.on('unhandledRejection', (r) => console.error('[diag] unhandledRejection:', r));
process.on('SIGINT', () => console.log('[diag] SIGINT received'));
process.on('SIGTERM', () => console.log('[diag] SIGTERM received'));
process.on('SIGHUP', () => console.log('[diag] SIGHUP received'));

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createAuthRoutes } = require('./routes/auth');

const app = express();

app.use(cors());
app.use(express.json());

// Debug: log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

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
  yandexAppId: process.env.YANDEX_CLIENT_ID,
  usersFile,
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('[diag] listening, hasRef =', server.listening);
});

server.on('close', () => console.log('[diag] server closed'));
server.on('error', (e) => console.error('[diag] server error:', e));

// Heartbeat every 5s — if the loop is alive these will print.
setInterval(() => {
  console.log('[diag] heartbeat', new Date().toISOString());
}, 5000);
