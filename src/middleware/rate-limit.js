import { CONFIG } from '../config.js';

const hits = new Map(); // ip -> { count, resetAt }

// Auto prune memory every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of hits.entries()) {
    if (now > record.resetAt) hits.delete(ip);
  }
}, 600000);

export function rateLimiter({ max = CONFIG.RATE_LIMIT_MAX, windowMs = CONFIG.RATE_LIMIT_WINDOW_MS } = {}) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let record = hits.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
      hits.set(ip, record);
    } else {
      record.count += 1;
    }

    if (record.count > max) {
      const retrySec = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'RATE_LIMITED',
        message: `Too many requests. Please wait ${retrySec} seconds before trying again.`,
      });
    }

    next();
  };
}
