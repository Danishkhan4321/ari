const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const key = process.env.ENCRYPTION_KEY || process.env.GOOGLE_ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY not set (set ENCRYPTION_KEY env var)');
  return Buffer.from(key, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return {
    encrypted,
    iv: iv.toString('base64'),
    authTag
  };
}

function decrypt(encrypted, iv, authTag) {
  if (!encrypted || !iv || !authTag) {
    throw new Error('Missing required decrypt parameters');
  }
  const key = getKey();
  let ivBuf, authTagBuf;
  try {
    ivBuf = Buffer.from(iv, 'base64');
    authTagBuf = Buffer.from(authTag, 'base64');
  } catch (err) {
    throw new Error('Corrupted encryption data: invalid base64 encoding');
  }
  if (ivBuf.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${ivBuf.length}`);
  }
  if (authTagBuf.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid authTag length: expected ${AUTH_TAG_LENGTH}, got ${authTagBuf.length}`);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTagBuf);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encrypt, decrypt };
