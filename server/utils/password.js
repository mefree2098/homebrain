const bcrypt = require('bcrypt');

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith('$2');
}

function validatePassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < PASSWORD_MIN_LENGTH) return false;
  return PASSWORD_REGEX.test(password);
}

async function hashPassword(password) {
  if (!validatePassword(password)) {
    throw new Error('Password must be at least 8 characters and include letters and numbers.');
  }
  return bcrypt.hash(password, 12);
}

async function comparePassword(candidate, hash) {
  if (!candidate || !hash) return false;
  return bcrypt.compare(candidate, hash);
}

module.exports = {
  hashPassword,
  comparePassword,
  validatePassword,
  isPasswordHash,
};