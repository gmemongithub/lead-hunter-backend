import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { SIGNING_PRIVATE_KEY } from './signing-keys.js';

/**
 * Signs an access token (JWT) for the client session (15m validity)
 */
export function signAccessToken(payload) {
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: '15m' });
}

/**
 * Signs a rotating refresh token (30 days validity)
 */
export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, type: 'refresh' }, CONFIG.JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Verifies JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Generates an encrypted & signed Work Token for the extension.
 * Contains dynamic cryptographic decryption seeds needed by the scraper.
 */
export function generateWorkToken(license, deviceId) {
  // Generate daily rotating seed based on server secret + date
  const dayString = new Date().toISOString().slice(0, 10);
  const rawSeed = crypto
    .createHmac('sha256', CONFIG.JWT_SECRET)
    .update(`${license.license_key}:${deviceId}:${dayString}`)
    .digest('hex');

  const payload = {
    lid: license.id,
    key: license.license_key,
    dev: deviceId,
    exp: license.expires_at || 0,
    term: license.term,
    seed: rawSeed.slice(0, 32),
    iat: Date.now(),
  };

  const json = JSON.stringify(payload);
  const signature = crypto
    .sign('SHA256', Buffer.from(json), { key: SIGNING_PRIVATE_KEY, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  return {
    token: Buffer.from(json).toString('base64url'),
    sig: signature,
    seed: rawSeed.slice(0, 32),
  };
}
