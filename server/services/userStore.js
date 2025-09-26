const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { hashPassword, comparePassword, isPasswordHash } = require('../utils/password');
const { ROLES } = require('../../shared/config/roles');

const dataDir = path.join(__dirname, '../data');
const usersFilePath = path.join(dataDir, 'users.json');

const DEFAULT_ADMIN_EMAIL = (process.env.HOMEBRAIN_ADMIN_EMAIL || process.env.DEFAULT_ADMIN_EMAIL || 'admin@homebrain.local').toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.HOMEBRAIN_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD || 'HomeBrainAdmin!123';
const DEFAULT_PASSWORD_FROM_ENV = Boolean(process.env.HOMEBRAIN_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD);

let users = [];
let initialized = false;
let pendingPersistence = false;

const ensureDataDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

const readUsersFromDisk = () => {
  if (!fs.existsSync(usersFilePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(usersFilePath, 'utf-8');
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.users)) {
      return parsed.users;
    }
  } catch (error) {
    console.warn('[Auth] Failed to read users from disk:', error.message);
  }
  return [];
};

const persistUsersToDisk = () => {
  if (!initialized) {
    pendingPersistence = true;
    return;
  }
  try {
    ensureDataDir();
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf-8');
    pendingPersistence = false;
  } catch (error) {
    console.warn('[Auth] Failed to persist users to disk:', error.message);
  }
};

const sanitizeUser = (user) => {
  if (!user) return null;
  const {
    password,
    passwordHash,
    refreshToken,
    _id,
    ...safe
  } = user;
  return safe;
};

const normalizeUser = (rawUser) => {
  if (!rawUser || typeof rawUser !== 'object') {
    return null;
  }

  const email = typeof rawUser.email === 'string' ? rawUser.email.trim().toLowerCase() : null;
  if (!email) {
    return null;
  }

  const passwordHash = rawUser.passwordHash || rawUser.password;
  if (!passwordHash || !isPasswordHash(passwordHash)) {
    console.warn(`[Auth] Skipping user ${email} because password hash is missing or invalid.`);
    return null;
  }

  const nowIso = new Date().toISOString();

  return {
    id: rawUser.id || rawUser._id || `user-${randomUUID()}`,
    email,
    passwordHash,
    role: rawUser.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.USER,
    isActive: typeof rawUser.isActive === 'boolean' ? rawUser.isActive : true,
    createdAt: rawUser.createdAt || nowIso,
    lastLoginAt: rawUser.lastLoginAt || null,
    refreshToken: rawUser.refreshToken || randomUUID(),
    requiresPasswordChange: Boolean(rawUser.requiresPasswordChange),
  };
};

const ensureDefaultAdmin = async () => {
  const hasActiveAdmin = users.some((user) => user.role === ROLES.ADMIN && user.isActive !== false);
  if (hasActiveAdmin) {
    return null;
  }

  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  const nowIso = new Date().toISOString();
  const adminUser = {
    id: `user-${randomUUID()}`,
    email: DEFAULT_ADMIN_EMAIL,
    passwordHash,
    role: ROLES.ADMIN,
    isActive: true,
    createdAt: nowIso,
    lastLoginAt: null,
    refreshToken: randomUUID(),
    requiresPasswordChange: !DEFAULT_PASSWORD_FROM_ENV,
  };

  users.push(adminUser);
  persistUsersToDisk();
  return adminUser;
};

const initializeUserStore = async () => {
  if (initialized) {
    return users;
  }

  const seenEmails = new Set();
  const normalizedUsers = [];
  const rawUsers = readUsersFromDisk();

  for (const raw of rawUsers) {
    const normalized = normalizeUser(raw);
    if (!normalized) {
      continue;
    }
    if (seenEmails.has(normalized.email)) {
      console.warn(`[Auth] Duplicate user email detected (${normalized.email}); ignoring subsequent entry.`);
      continue;
    }
    seenEmails.add(normalized.email);
    normalizedUsers.push(normalized);
  }

  users = normalizedUsers;
  initialized = true;

  if (pendingPersistence) {
    persistUsersToDisk();
  }

  const createdAdmin = await ensureDefaultAdmin();
  if (createdAdmin) {
    console.warn(`[Auth] Default admin account created for ${createdAdmin.email}. Update HOMEBRAIN_ADMIN_EMAIL and HOMEBRAIN_ADMIN_PASSWORD environment variables and rotate the password.`);
  }

  return users;
};

const requireInitialization = async () => {
  if (!initialized) {
    await initializeUserStore();
  }
};

const findUserByEmail = (email) => {
  if (!email) {
    return null;
  }
  const normalizedEmail = email.trim().toLowerCase();
  return users.find((user) => user.email === normalizedEmail) || null;
};

const findUserByRefreshToken = (refreshToken) => {
  if (!refreshToken) {
    return null;
  }
  return users.find((user) => user.refreshToken === refreshToken) || null;
};

const verifyUserCredentials = async (email, password) => {
  await requireInitialization();
  const user = findUserByEmail(email);
  if (!user || user.isActive === false) {
    return null;
  }

  const matches = await comparePassword(password, user.passwordHash);
  if (!matches) {
    return null;
  }

  return user;
};

const updateUser = (userId, updates = {}) => {
  if (!userId) {
    return null;
  }
  const index = users.findIndex((user) => user.id === userId);
  if (index === -1) {
    return null;
  }
  users[index] = {
    ...users[index],
    ...updates,
  };
  persistUsersToDisk();
  return users[index];
};

const rotateRefreshToken = (userId) => {
  if (!userId) {
    return null;
  }
  const user = users.find((entry) => entry.id === userId);
  if (!user) {
    return null;
  }
  const token = randomUUID();
  user.refreshToken = token;
  persistUsersToDisk();
  return token;
};

const revokeRefreshToken = (refreshToken) => {
  const user = findUserByRefreshToken(refreshToken);
  if (!user) {
    return null;
  }
  user.refreshToken = randomUUID();
  persistUsersToDisk();
  return user;
};

const getUsers = () => users.map((user) => sanitizeUser(user));

module.exports = {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_PASSWORD_FROM_ENV,
  initializeUserStore,
  verifyUserCredentials,
  findUserByRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  sanitizeUser,
  updateUser,
  getUsers,
};



