import crypto from 'crypto';
import { CONFIG } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Derives a 32-byte key from master secret using SHA-256
 */
function getDerivedKey(salt = 'lead_hunter_salt') {
  return crypto.createHash('sha256').update(CONFIG.ENCRYPTION_MASTER_KEY + salt).digest();
}

/**
 * Encrypts sensitive text (e.g. user password) using AES-256-GCM
 */
export function encryptSensitive(plaintext) {
  if (!plaintext) return '';
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  // Format: iv:tag:encrypted
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM payload.
 * Requires Admin Master Password confirmation before revealing.
 */
export function decryptSensitive(payload, adminPasswordAttempt) {
  if (!payload) return '';
  if (adminPasswordAttempt !== CONFIG.ADMIN_PASSWORD) {
    throw new Error('Invalid Admin Master Password. Decryption denied.');
  }

  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted payload');

  const [ivHex, tagHex, encryptedHex] = parts;
  const key = getDerivedKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
