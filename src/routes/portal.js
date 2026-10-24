import express from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/database.js';
import { requirePortalAuth } from '../middleware/auth.js';
import { generateLicenseKey, generateId } from '../crypto/keygen.js';
import { encryptSensitive } from '../crypto/cipher.js';
import { signAccessToken } from '../crypto/tokens.js';
import { rateLimiter } from '../middleware/rate-limit.js';
import { computeExpiry } from './api-v1.js';

const router = express.Router();

/**
 * 1. BUYER ONBOARDING VIA MAGIC SIGN-UP LINK
 * POST /portal/api/setup-invite
 */
router.post('/setup-invite', rateLimiter({ max: 10 }), (req, res) => {
  const { token, name, email, password } = req.body || {};
  if (!token || !name || !email || !password) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'All fields are required.' });
  }

  const db = getDb();
  const link = db.prepare("SELECT * FROM magic_links WHERE token = ? AND type = 'invite' AND used = 0").get(token);
  if (!link) {
    return res.status(404).json({ error: 'INVALID_INVITE', message: 'This invite link is invalid or has already been used.' });
  }

  if (Date.now() > link.expires_at) {
    return res.status(410).json({ error: 'EXPIRED_INVITE', message: 'This invite link has expired. Please contact support.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existingUser) {
    return res.status(409).json({ error: 'EMAIL_EXISTS', message: 'An account with this email already exists. Please log in.' });
  }

  const userId = generateId('usr');
  const now = Date.now();
  const hash = bcrypt.hashSync(password, 10);
  const enc = encryptSensitive(password);

  // Create User
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, password_enc, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'customer', ?, ?)
  `).run(userId, cleanEmail, name.trim(), hash, enc, now, now);

  // Attach & activate license
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(link.license_id);
  let expiresAt = null;
  if (license) {
    expiresAt = computeExpiry(license.term, license.days);
    db.prepare(`
      UPDATE licenses SET user_id = ?, status = 'ACTIVE', customer_name = ?, activated_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, name.trim(), now, expiresAt, now, license.id);
  }

  // Mark invite used
  db.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').run(link.id);

  const portalToken = signAccessToken({ sub: userId, email: cleanEmail, name: name.trim(), role: 'customer' });
  return res.json({
    ok: true,
    message: 'Account successfully created and activated!',
    token: portalToken,
    user: { id: userId, name: name.trim(), email: cleanEmail },
    licenseKey: license ? license.license_key : null,
  });
});

/**
 * 2. PORTAL LOGIN
 * POST /portal/api/login
 */
router.post('/login', rateLimiter({ max: 15 }), (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Email and password required.' });

  const db = getDb();
  const cleanEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }

  const token = signAccessToken({ sub: user.id, email: user.email, name: user.name, role: 'customer' });
  return res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email } });
});

/**
 * 3. MY ACCOUNT & LICENSE STATUS
 * GET /portal/api/my-account
 */
router.get('/my-account', requirePortalAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found.' });

  const license = db.prepare("SELECT * FROM licenses WHERE user_id = ? AND status != 'REVOKED' ORDER BY created_at DESC LIMIT 1").get(user.id);
  let devices = [];
  if (license) {
    devices = db.prepare('SELECT id, device_id, device_name, ip, last_seen_at FROM devices WHERE license_id = ? ORDER BY last_seen_at DESC').all(license.id);
  }

  let daysLeft = null;
  if (license?.expires_at) {
    daysLeft = Math.max(0, Math.ceil((license.expires_at - Date.now()) / 86400000));
  } else if (license?.term === 'lifetime') {
    daysLeft = 'Lifetime';
  }

  return res.json({
    user,
    license: license
      ? {
          key: license.license_key,
          status: license.status,
          term: license.term,
          expiresAt: license.expires_at,
          daysLeft,
          deviceLimit: license.device_limit,
          maxRegenerations: license.max_regenerations,
          regenerationsUsed: license.regenerations_used,
        }
      : null,
    devices,
  });
});

/**
 * 4. REMOVE ACTIVE DEVICE
 * POST /portal/api/remove-device
 */
router.post('/remove-device', requirePortalAuth, (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'deviceId required.' });

  const db = getDb();
  const license = db.prepare("SELECT id FROM licenses WHERE user_id = ? AND status != 'REVOKED' ORDER BY created_at DESC LIMIT 1").get(req.user.sub);
  if (!license) return res.status(404).json({ error: 'NOT_FOUND', message: 'No active license found.' });

  db.prepare('DELETE FROM devices WHERE license_id = ? AND device_id = ?').run(license.id, deviceId);
  return res.json({ ok: true, message: 'Device successfully removed.' });
});

/**
 * 5. REGENERATE LEAKED LICENSE KEY (with admin-defined limit)
 * POST /portal/api/regenerate-key
 */
router.post('/regenerate-key', requirePortalAuth, (req, res) => {
  const db = getDb();
  const license = db.prepare("SELECT * FROM licenses WHERE user_id = ? AND status != 'REVOKED' ORDER BY created_at DESC LIMIT 1").get(req.user.sub);
  if (!license) return res.status(404).json({ error: 'NOT_FOUND', message: 'No active license found.' });

  if (license.regenerations_used >= license.max_regenerations) {
    return res.status(403).json({
      error: 'LIMIT_EXCEEDED',
      message: `You have reached the maximum allowed key regenerations (${license.max_regenerations}/${license.max_regenerations}). Please contact support to reset.`,
    });
  }

  // Revoke old key and evict devices
  const now = Date.now();
  db.prepare("UPDATE licenses SET status = 'REVOKED', updated_at = ? WHERE id = ?").run(now, license.id);
  db.prepare('DELETE FROM devices WHERE license_id = ?').run(license.id);

  // Generate new key under same plan & expiry
  const newKey = generateLicenseKey('LH');
  const newId = generateId('lic');
  const newRegenCount = license.regenerations_used + 1;

  db.prepare(`
    INSERT INTO licenses (
      id, user_id, license_key, status, term, days, device_limit,
      max_regenerations, regenerations_used, customer_name, admin_notes, activated_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId,
    license.user_id,
    newKey,
    license.term,
    license.days,
    license.device_limit,
    license.max_regenerations,
    newRegenCount,
    license.customer_name,
    license.admin_notes,
    license.activated_at,
    license.expires_at,
    now,
    now
  );

  return res.json({
    ok: true,
    newKey,
    regenerationsUsed: newRegenCount,
    maxRegenerations: license.max_regenerations,
    message: 'Your old license key has been revoked and all devices disconnected. Use your new key to activate.',
  });
});

/**
 * 6. CHANGE PASSWORD
 * POST /portal/api/change-password
 */
router.post('/change-password', requirePortalAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'New password must be at least 6 characters.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Current password does not match.' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  const enc = encryptSensitive(newPassword);

  db.prepare('UPDATE users SET password_hash = ?, password_enc = ?, updated_at = ? WHERE id = ?').run(hash, enc, Date.now(), user.id);
  return res.json({ ok: true, message: 'Password changed successfully.' });
});

/**
 * 7. COMPLETE PASSWORD RESET (via magic reset link)
 * POST /portal/api/reset-password
 */
router.post('/reset-password', rateLimiter({ max: 5 }), (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Valid token and minimum 6 character password required.' });
  }

  const db = getDb();
  const link = db.prepare("SELECT * FROM magic_links WHERE token = ? AND type = 'password_reset' AND used = 0").get(token);
  if (!link || Date.now() > link.expires_at) {
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Password reset link is invalid or has expired.' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  const enc = encryptSensitive(newPassword);

  db.prepare('UPDATE users SET password_hash = ?, password_enc = ?, updated_at = ? WHERE id = ?').run(hash, enc, Date.now(), link.user_id);
  db.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').run(link.id);

  return res.json({ ok: true, message: 'Password successfully reset! You can now log in.' });
});

export default router;
