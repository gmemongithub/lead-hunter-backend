import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/database.js';
import { CONFIG } from '../config.js';
import { requireAdminAuth } from '../middleware/auth.js';
import { generateLicenseKey, generateId, generateSecureToken } from '../crypto/keygen.js';
import { encryptSensitive, decryptSensitive } from '../crypto/cipher.js';
import { signAccessToken } from '../crypto/tokens.js';
import { computeExpiry } from './api-v1.js';

const router = express.Router();

/**
 * Admin Login
 * POST /admin/api/login
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== CONFIG.ADMIN_USERNAME || password !== CONFIG.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid Admin username or password.' });
  }

  // Issue 7-day administrative session token
  const token = jwt.sign({ username, role: 'superadmin' }, CONFIG.JWT_SECRET, { expiresIn: '7d' });
  return res.json({ ok: true, token, username });
});

/**
 * Dashboard Stats
 * GET /admin/api/stats
 */
router.get('/stats', requireAdminAuth, (req, res) => {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalLicenses = db.prepare('SELECT COUNT(*) as c FROM licenses').get().c;
  const activeLicenses = db.prepare("SELECT COUNT(*) as c FROM licenses WHERE status = 'ACTIVE'").get().c;
  const activeDevices = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
  const openBugs = db.prepare("SELECT COUNT(*) as c FROM bug_reports WHERE status = 'OPEN'").get().c;

  const stats = {
    totalUsers,
    totalLicenses,
    activeLicenses,
    activeDevices,
    openBugs,
  };

  return res.json({
    stats,
    ...stats,
  });
});

/**
 * List Licenses
 * GET /admin/api/licenses
 */
router.get('/licenses', requireAdminAuth, (req, res) => {
  const { status, search } = req.query || {};
  const db = getDb();
  let query = 'SELECT l.*, u.email as user_email, u.name as user_account_name FROM licenses l LEFT JOIN users u ON l.user_id = u.id WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND l.status = ?';
    params.push(status);
  }
  if (search) {
    query += ' AND (l.license_key LIKE ? OR l.customer_name LIKE ? OR u.email LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  query += ' ORDER BY l.created_at DESC LIMIT 200';
  const licenses = db.prepare(query).all(...params);

  return res.json({ licenses });
});

/**
 * Create Single License Key
 * POST /admin/api/licenses/create
 */
router.post('/licenses/create', requireAdminAuth, (req, res) => {
  const {
    term = '1m',
    customDays = null,
    deviceLimit = 2,
    maxRegenerations = 3,
    customerName = '',
    adminNotes = '',
  } = req.body || {};

  const db = getDb();
  const key = generateLicenseKey('LH');
  const id = generateId('lic');
  const now = Date.now();
  const parsedDays = term === 'custom' ? parseInt(customDays, 10) || 30 : null;

  db.prepare(`
    INSERT INTO licenses (
      id, license_key, status, term, days, device_limit,
      max_regenerations, regenerations_used, customer_name, admin_notes, created_at, updated_at
    ) VALUES (?, ?, 'UNCLAIMED', ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(id, key, term, parsedDays, parseInt(deviceLimit, 10) || 2, parseInt(maxRegenerations, 10) || 3, customerName.trim(), adminNotes.trim(), now, now);

  return res.json({ ok: true, key, id });
});

/**
 * Bulk Create License Keys (for Giveaways or Resellers)
 * POST /admin/api/licenses/bulk-create
 */
router.post('/licenses/bulk-create', requireAdminAuth, (req, res) => {
  const { count = 10, term = '1m', customDays = null, deviceLimit = 2, label = 'Giveaway' } = req.body || {};
  const qty = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
  const db = getDb();
  const now = Date.now();
  const keys = [];

  const parsedDays = term === 'custom' ? parseInt(customDays, 10) || 30 : null;

  const insert = db.prepare(`
    INSERT INTO licenses (
      id, license_key, status, term, days, device_limit,
      max_regenerations, regenerations_used, customer_name, created_at, updated_at
    ) VALUES (?, ?, 'UNCLAIMED', ?, ?, ?, 3, 0, ?, ?, ?)
  `);

  for (let i = 0; i < qty; i++) {
    const key = generateLicenseKey('LH');
    const id = generateId('lic');
    insert.run(id, key, term, parsedDays, parseInt(deviceLimit, 10) || 2, `${label} #${i + 1}`, now, now);
    keys.push(key);
  }

  return res.json({ ok: true, count: keys.length, keys });
});

/**
 * Change License Status (ACTIVE / SUSPENDED / REVOKED)
 * POST /admin/api/licenses/:id/status
 */
router.post('/licenses/:id/status', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(status)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Valid status required.' });
  }

  const db = getDb();
  db.prepare('UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  return res.json({ ok: true, status });
});

/**
 * Extend License by extra days
 * POST /admin/api/licenses/:id/extend
 */
router.post('/licenses/:id/extend', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { addDays } = req.body || {};
  const daysNum = parseInt(addDays, 10);
  if (!daysNum || daysNum <= 0) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Days must be positive integer.' });

  const db = getDb();
  const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id);
  if (!lic) return res.status(404).json({ error: 'NOT_FOUND', message: 'License not found.' });

  const currentExp = lic.expires_at ? Math.max(lic.expires_at, Date.now()) : Date.now();
  const newExp = currentExp + daysNum * 86400000;

  db.prepare("UPDATE licenses SET expires_at = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?").run(newExp, Date.now(), id);
  return res.json({ ok: true, newExpiresAt: newExp });
});

/**
 * List Users
 * GET /admin/api/users
 */
router.get('/users', requireAdminAuth, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.created_at,
           l.license_key, l.status as license_status, l.term as license_term, l.expires_at
    FROM users u
    LEFT JOIN licenses l ON l.user_id = u.id AND l.status != 'REVOKED'
    ORDER BY u.created_at DESC LIMIT 200
  `).all();

  return res.json({ users });
});

/**
 * Reveal User Password (Master Password Protected!)
 * POST /admin/api/users/:id/reveal-password
 */
router.post('/users/:id/reveal-password', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { adminPassword } = req.body || {};

  if (!adminPassword || adminPassword !== CONFIG.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Incorrect Admin Master Password. Access denied.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT password_enc, email FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found.' });

  try {
    const plainPassword = decryptSensitive(user.password_enc, adminPassword);
    return res.json({ ok: true, email: user.email, password: plainPassword });
  } catch (err) {
    return res.status(500).json({ error: 'DECRYPTION_ERROR', message: err.message });
  }
});

/**
 * Force Set User Password
 * POST /admin/api/users/:id/set-password
 */
router.post('/users/:id/set-password', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Password must be at least 6 characters.' });
  }

  const db = getDb();
  const hash = bcrypt.hashSync(newPassword, 10);
  const enc = encryptSensitive(newPassword);

  db.prepare('UPDATE users SET password_hash = ?, password_enc = ?, updated_at = ? WHERE id = ?').run(hash, enc, Date.now(), id);
  return res.json({ ok: true, message: 'Password successfully updated.' });
});

/**
 * Generate Magic Sign-Up Invite Link for Buyer
 * POST /admin/api/invites/create and /admin/api/magic-invite
 */
function handleCreateInvite(req, res) {
  const { term = '1m', customDays = null, customerName = '', deviceLimit = 2 } = req.body || {};
  const db = getDb();
  const token = generateSecureToken(24);
  const inviteId = generateId('inv');
  const licenseId = generateId('lic');
  const key = generateLicenseKey('LH');
  const now = Date.now();
  const parsedDays = term === 'custom' ? parseInt(customDays, 10) || 30 : null;

  // Pre-create the unactivated license
  db.prepare(`
    INSERT INTO licenses (
      id, license_key, status, term, days, device_limit,
      max_regenerations, regenerations_used, customer_name, created_at, updated_at
    ) VALUES (?, ?, 'UNCLAIMED', ?, ?, ?, 3, 0, ?, ?, ?)
  `).run(licenseId, key, term, parsedDays, parseInt(deviceLimit, 10) || 2, customerName.trim(), now, now);

  // Create invite record (valid for 7 days)
  const expiresAt = now + 7 * 86400000;
  db.prepare(`
    INSERT INTO magic_links (id, token, type, license_id, expires_at, created_at)
    VALUES (?, ?, 'invite', ?, ?, ?)
  `).run(inviteId, token, licenseId, expiresAt, now);

  const inviteUrl = `${CONFIG.APP_URL}/portal/setup?token=${token}`;
  return res.json({ ok: true, inviteUrl, url: inviteUrl, token, licenseKey: key, expiresAt });
}
router.post('/invites/create', requireAdminAuth, handleCreateInvite);
router.post('/magic-invite', requireAdminAuth, handleCreateInvite);

/**
 * List Active Invite Links
 * GET /admin/api/invites/active and /admin/api/magic-invites/active
 */
function handleGetActiveInvites(req, res) {
  const db = getDb();
  const now = Date.now();
  const invites = db.prepare(`
    SELECT m.id, m.token, m.expires_at, m.created_at,
           l.license_key, l.term, l.device_limit
    FROM magic_links m
    LEFT JOIN licenses l ON l.id = m.license_id
    WHERE m.type = 'invite' AND m.used = 0 AND m.expires_at > ?
    ORDER BY m.created_at DESC LIMIT 100
  `).all(now);

  return res.json({ ok: true, invites });
}
router.get('/invites/active', requireAdminAuth, handleGetActiveInvites);
router.get('/magic-invites/active', requireAdminAuth, handleGetActiveInvites);

/**
 * Generate Magic Password Reset Link for User
 * POST /admin/api/users/:id/reset-link
 */
router.post('/users/:id/reset-link', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found.' });

  const token = generateSecureToken(24);
  const linkId = generateId('rst');
  const expiresAt = Date.now() + 2 * 86400000; // 48 hours

  db.prepare(`
    INSERT INTO magic_links (id, token, type, user_id, email, expires_at, created_at)
    VALUES (?, ?, 'password_reset', ?, ?, ?, ?)
  `).run(linkId, token, user.id, user.email, expiresAt, Date.now());

  const resetUrl = `${CONFIG.APP_URL}/portal/reset-password?token=${token}`;
  return res.json({ ok: true, resetUrl, email: user.email });
});

/**
 * View & Update Bug Reports
 * GET /admin/api/bugs
 * POST /admin/api/bugs/:id/status
 */
router.get('/bugs', requireAdminAuth, (req, res) => {
  const db = getDb();
  const bugs = db.prepare('SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 100').all();
  return res.json({ bugs });
});

router.post('/bugs/:id/status', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const db = getDb();
  db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run(status, id);
  return res.json({ ok: true });
});

/**
 * View Audit Logs
 * GET /admin/api/audit-logs
 */
router.get('/audit-logs', requireAdminAuth, (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150').all();
  return res.json({ logs });
});

export default router;
