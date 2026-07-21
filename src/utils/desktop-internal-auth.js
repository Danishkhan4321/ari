'use strict';

const crypto = require('node:crypto');
const { validateUserId } = require('./security');

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function tokensEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createDesktopInternalAuth({ token = process.env.ARI_DESKTOP_INTERNAL_TOKEN } = {}) {
  const expectedToken = String(token || '');
  return function desktopInternalAuth(req, res, next) {
    const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip;
    if (!isLoopbackAddress(remoteAddress)) {
      return res.status(403).json({ ok: false, error: 'Desktop meeting access is loopback-only.' });
    }
    if (!expectedToken) {
      return res.status(503).json({ ok: false, error: 'Desktop meeting recording is not configured.' });
    }
    if (!tokensEqual(req.get?.('x-ari-desktop-token') || req.headers?.['x-ari-desktop-token'], expectedToken)) {
      return res.status(401).json({ ok: false, error: 'Desktop meeting authentication failed.' });
    }
    const validatedUserPhone = validateUserId(req.get?.('x-ari-user-phone') || req.headers?.['x-ari-user-phone']);
    if (!validatedUserPhone) {
      return res.status(400).json({ ok: false, error: 'A valid desktop user identity is required.' });
    }
    req.ariUserPhone = /^\+\d+$/.test(validatedUserPhone)
      ? validatedUserPhone.slice(1)
      : validatedUserPhone;
    return next();
  };
}

module.exports = { createDesktopInternalAuth, isLoopbackAddress, tokensEqual };
