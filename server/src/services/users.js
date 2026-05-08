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
