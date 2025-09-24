const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '1h';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '30d';

function getAccessTokenSecret() {
  return process.env.ACCESS_TOKEN_SECRET || 'homebrain-access-secret';
}

function getRefreshTokenSecret() {
  return process.env.REFRESH_TOKEN_SECRET || 'homebrain-refresh-secret';
}

function issueAccessToken(payload) {
  return jwt.sign(payload, getAccessTokenSecret(), { expiresIn: ACCESS_TOKEN_TTL });
}

function issueRefreshToken(payload) {
  return jwt.sign(payload, getRefreshTokenSecret(), { expiresIn: REFRESH_TOKEN_TTL });
}

function verifyAccessToken(token) {
  return jwt.verify(token, getAccessTokenSecret());
}

function verifyRefreshToken(token) {
  return jwt.verify(token, getRefreshTokenSecret());
}

function generateRefreshTokenValue() {
  return crypto.randomUUID();
}

module.exports = {
  issueAccessToken,
  issueRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateRefreshTokenValue,
};