'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_FILE_NAME = 'desktop-launch-token';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function tokenPath(userDataPath) {
  return path.join(userDataPath, TOKEN_FILE_NAME);
}

function loadOrCreateInternalToken(userDataPath) {
  const filePath = tokenPath(userDataPath);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) return { token: existing, filePath, reused: true };
  } catch (_) {}

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return { token, filePath, reused: false };
}

function removeInternalToken(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = { TOKEN_FILE_NAME, loadOrCreateInternalToken, removeInternalToken, tokenPath };
