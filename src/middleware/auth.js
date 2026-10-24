import { verifyToken } from '../crypto/tokens.js';
import { CONFIG } from '../config.js';
import { getDb } from '../db/database.js';

export function requireExtensionAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid authorization header.' });
  }

  const token = header.slice(7).trim();
  const decoded = verifyToken(token);
  if (!decoded || decoded.type === 'refresh') {
    return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'Session token has expired or is invalid.' });
  }

  // Version enforcement (PRD Section 32)
  const extVer = req.headers['x-extension-version'];
  if (extVer && isVersionLower(extVer, CONFIG.MIN_EXTENSION_VERSION)) {
    return res.status(426).json({
      error: 'UPDATE_REQUIRED',
      message: `Your extension version (${extVer}) is deprecated. Minimum required is ${CONFIG.MIN_EXTENSION_VERSION}. Please update.`,
    });
  }

  req.auth = decoded;
  next();
}

export function requireAdminAuth(req, res, next) {
  const adminSecret = req.headers['x-admin-key'] || req.cookies?.admin_token || req.headers.authorization?.replace(/^Bearer /i, '');
  
  if (!adminSecret) {
    return res.status(401).json({ error: 'ADMIN_UNAUTHORIZED', message: 'Admin authentication required.' });
  }

  // Support direct admin password or admin JWT token
  if (adminSecret === CONFIG.ADMIN_PASSWORD) {
    req.admin = { username: CONFIG.ADMIN_USERNAME, role: 'superadmin' };
    return next();
  }

  const decoded = verifyToken(adminSecret);
  if (decoded && decoded.role === 'superadmin') {
    req.admin = decoded;
    return next();
  }

  return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid admin credentials.' });
}

export function requirePortalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'PORTAL_UNAUTHORIZED', message: 'Please login to continue.' });
  }

  const token = header.slice(7).trim();
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'customer') {
    return res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Portal session expired. Please log in again.' });
  }

  req.user = decoded;
  next();
}

function isVersionLower(current, minimum) {
  const c = current.split('.').map(Number);
  const m = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((c[i] || 0) < (m[i] || 0)) return true;
    if ((c[i] || 0) > (m[i] || 0)) return false;
  }
  return false;
}
