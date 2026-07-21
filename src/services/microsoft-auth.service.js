const axios = require('axios');
const crypto = require('crypto');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Calendars.ReadWrite',
  'Mail.Read',
  'User.Read'
];

const HMAC_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
if (!HMAC_SECRET) {
  console.warn('WARNING: MICROSOFT_CLIENT_SECRET not set — Outlook OAuth will not work');
}

class MicrosoftAuthService {

  constructor() {
    this.tableCreated = false;
  }

  async ensureTable() {
    if (this.tableCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS microsoft_tokens (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) UNIQUE NOT NULL,
          access_token_enc TEXT NOT NULL,
          refresh_token_enc TEXT,
          token_iv VARCHAR(64) NOT NULL,
          token_auth_tag VARCHAR(64) NOT NULL,
          refresh_iv VARCHAR(64),
          refresh_auth_tag VARCHAR(64),
          microsoft_email VARCHAR(255),
          scopes TEXT,
          token_expiry TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_microsoft_tokens_phone ON microsoft_tokens(user_phone)`);
      this.tableCreated = true;
    } catch (error) {
      logger.error('Error creating microsoft_tokens table:', error.message);
    }
  }

  generateStateParam(userPhone) {
    const payload = `${userPhone}:${Date.now()}`;
    const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
    return Buffer.from(`${payload}:${hmac}`).toString('base64url');
  }

  validateStateParam(state) {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length < 3) return null;

      const hmac = parts.pop();
      const payload = parts.join(':');
      const [userPhone, timestamp] = payload.split(':');

      const expected = crypto.createHmac('sha256', HMAC_SECRET).update(`${userPhone}:${timestamp}`).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) {
        return null;
      }

      if (Date.now() - parseInt(timestamp) > 10 * 60 * 1000) {
        return null;
      }

      return userPhone;
    } catch (error) {
      logger.error('MS state validation error:', error.message);
      return null;
    }
  }

  generateAuthUrl(userPhone) {
    if (!process.env.MICROSOFT_CLIENT_ID) return null;

    const state = this.generateStateParam(userPhone);
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
      scope: MS_SCOPES.join(' '),
      state,
      prompt: 'consent'
    });

    return `${MS_AUTH_URL}/authorize?${params.toString()}`;
  }

  async handleCallback(code, state) {
    const userPhone = this.validateStateParam(state);
    if (!userPhone) {
      throw new Error('Invalid or expired authorization state');
    }

    const tokenResponse = await axios.post(`${MS_AUTH_URL}/token`, new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
      grant_type: 'authorization_code'
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const tokens = tokenResponse.data;

    // Get user email
    const profileResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const msEmail = profileResponse.data.mail || profileResponse.data.userPrincipalName;

    // Encrypt tokens
    const accessEnc = encrypt(tokens.access_token);
    const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    await this.ensureTable();

    await query(`
      INSERT INTO microsoft_tokens (
        user_phone, access_token_enc, token_iv, token_auth_tag,
        refresh_token_enc, refresh_iv, refresh_auth_tag,
        microsoft_email, scopes, token_expiry, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (user_phone) DO UPDATE SET
        access_token_enc = $2, token_iv = $3, token_auth_tag = $4,
        refresh_token_enc = COALESCE($5, microsoft_tokens.refresh_token_enc),
        refresh_iv = COALESCE($6, microsoft_tokens.refresh_iv),
        refresh_auth_tag = COALESCE($7, microsoft_tokens.refresh_auth_tag),
        microsoft_email = $8, scopes = $9, token_expiry = $10, updated_at = NOW()
    `, [
      userPhone,
      accessEnc.encrypted, accessEnc.iv, accessEnc.authTag,
      refreshEnc?.encrypted || null, refreshEnc?.iv || null, refreshEnc?.authTag || null,
      msEmail, MS_SCOPES.join(','),
      tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
    ]);

    return { userPhone, msEmail };
  }

  async getAccessToken(userPhone) {
    await this.ensureTable();

    const result = await query(
      `SELECT * FROM microsoft_tokens WHERE user_phone = $1`,
      [userPhone]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];

    try {
      let accessToken = decrypt(row.access_token_enc, row.token_iv, row.token_auth_tag);

      // Auto-refresh if expiring within 5 minutes
      if (row.token_expiry && new Date(row.token_expiry).getTime() - Date.now() < 5 * 60 * 1000) {
        if (row.refresh_token_enc && row.refresh_iv && row.refresh_auth_tag) {
          try {
            const refreshToken = decrypt(row.refresh_token_enc, row.refresh_iv, row.refresh_auth_tag);
            const refreshResponse = await axios.post(`${MS_AUTH_URL}/token`, new URLSearchParams({
              client_id: process.env.MICROSOFT_CLIENT_ID,
              client_secret: process.env.MICROSOFT_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: 'refresh_token'
            }), {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const newTokens = refreshResponse.data;
            accessToken = newTokens.access_token;

            const newAccessEnc = encrypt(accessToken);
            const newRefreshEnc = newTokens.refresh_token ? encrypt(newTokens.refresh_token) : null;

            await query(`
              UPDATE microsoft_tokens SET
                access_token_enc = $1, token_iv = $2, token_auth_tag = $3,
                ${newRefreshEnc ? 'refresh_token_enc = $6, refresh_iv = $7, refresh_auth_tag = $8,' : ''}
                token_expiry = $4, updated_at = NOW()
              WHERE user_phone = $5
            `, newRefreshEnc ? [
              newAccessEnc.encrypted, newAccessEnc.iv, newAccessEnc.authTag,
              new Date(Date.now() + (newTokens.expires_in || 3600) * 1000),
              userPhone,
              newRefreshEnc.encrypted, newRefreshEnc.iv, newRefreshEnc.authTag
            ] : [
              newAccessEnc.encrypted, newAccessEnc.iv, newAccessEnc.authTag,
              new Date(Date.now() + (newTokens.expires_in || 3600) * 1000),
              userPhone
            ]);
          } catch (refreshError) {
            logger.warn(`MS token refresh failed for ${userPhone}:`, refreshError.message);
          }
        }
      }

      return accessToken;
    } catch (error) {
      logger.error(`MS token decryption failed for ${userPhone}:`, error.message);
      return null;
    }
  }

  async isConnected(userPhone) {
    await this.ensureTable();
    const result = await query(
      `SELECT 1 FROM microsoft_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rows.length > 0;
  }

  async getMicrosoftEmail(userPhone) {
    await this.ensureTable();
    const result = await query(
      `SELECT microsoft_email FROM microsoft_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rows[0]?.microsoft_email || null;
  }

  async revokeTokens(userPhone) {
    await this.ensureTable();
    const result = await query(
      `SELECT 1 FROM microsoft_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    if (result.rows.length === 0) return false;

    await query(`DELETE FROM microsoft_tokens WHERE user_phone = $1`, [userPhone]);
    return true;
  }

  async handleTokenError(userPhone, error) {
    const status = error.response?.status;

    if (status === 401 || error.message?.includes('InvalidAuthenticationToken')) {
      logger.warn(`MS token invalid for ${userPhone}, clearing tokens`);
      await query(`DELETE FROM microsoft_tokens WHERE user_phone = $1`, [userPhone]);
      return {
        cleared: true,
        message: 'Your Outlook connection expired. Say "connect outlook" to reconnect.'
      };
    }

    return { cleared: false, message: null };
  }
}

module.exports = new MicrosoftAuthService();
