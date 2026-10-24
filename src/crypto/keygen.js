import crypto from 'crypto';

/**
 * Generates an enterprise-style License Key:
 * e.g., LH-7A8B-9C0D-1E2F
 */
export function generateLicenseKey(prefix = 'LH') {
  const bytes = crypto.randomBytes(6).toString('hex').toUpperCase();
  const chunk1 = bytes.slice(0, 4);
  const chunk2 = bytes.slice(4, 8);
  const chunk3 = bytes.slice(8, 12);
  return `${prefix}-${chunk1}-${chunk2}-${chunk3}`;
}

/**
 * Generates secure URL-safe random token (for magic links & session nonces)
 */
export function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Unique ID generator for DB rows
 */
export function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
