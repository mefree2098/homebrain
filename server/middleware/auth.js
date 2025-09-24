const { verifyAccessToken } = require('../utils/tokens');

const PUBLIC_PATTERNS = [
  /^\/api\/auth\//,
  /^\/api\/ping$/,
  /^\/logs/,
];

function isPublicRoute(req) {
  return PUBLIC_PATTERNS.some((pattern) => pattern.test(req.path));
}

function authMiddleware(req, res, next) {
  if (isPublicRoute(req)) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired access token' });
  }
}

module.exports = { authMiddleware, isPublicRoute };