const { google } = require('googleapis');
const crypto = require('crypto');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');
const composioConnector = require('./composio-connector.service');

const COMPOSIO_GOOGLE_PRODUCTS = Object.freeze([
  'gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'tasks'
]);

const COMPOSIO_AUTH_CONFIG_ENV = Object.freeze({
  gmail: 'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  calendar: 'COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID',
  drive: 'COMPOSIO_GOOGLE_DRIVE_AUTH_CONFIG_ID',
  docs: 'COMPOSIO_GOOGLE_DOCS_AUTH_CONFIG_ID',
  sheets: 'COMPOSIO_GOOGLE_SHEETS_AUTH_CONFIG_ID',
  slides: 'COMPOSIO_GOOGLE_SLIDES_AUTH_CONFIG_ID',
  tasks: 'COMPOSIO_GOOGLE_TASKS_AUTH_CONFIG_ID',
});

/**
 * Stable signed-int8 hash of a string for use as a Postgres advisory lock id.
 * Postgres advisory locks take int8, but JS bitwise ops are int32 — we shift
 * the upper bits in via a separate accumulator and clamp to int8 range using
 * BigInt at the end. Same input always produces the same lock id, so two
 * concurrent callers for the same user_phone collide on the same lock and
 * can be serialised.
 */
function _hashLockId(input) {
  const buf = crypto.createHash('sha1').update(String(input)).digest();
  // First 8 bytes as a signed BigInt
  const hi = BigInt(buf.readInt32BE(0));
  const lo = BigInt(buf.readUInt32BE(4));
  return Number(((hi << 32n) | lo) & ((1n << 63n) - 1n));
}

// Base scopes — granted on "connect google"
// Must match the scope list configured in Google Cloud Console Data Access.
//
// PHASE 1 (current): SENSITIVE-only scope set. We dropped 4 RESTRICTED scopes
// (gmail.readonly, gmail.modify, drive.readonly, drive.metadata.readonly) to
// avoid Google's mandatory CASA security assessment ($500-$4500/yr,
// 2-6 month timeline). This lets us pass standard OAuth verification in
// 3-5 days for free. The features that depend on those scopes
// (inbox-read, archive, broad-Drive-search, auto-label cron, reply tracking)
// are removed from the active tool catalog and blocked at the controller
// boundary. Their legacy handlers remain only for compatibility.
//
// PHASE 2 (future): once revenue justifies CASA, re-add those 4 scopes here
// and re-enable the disabled handlers + crons.
const BASE_SCOPES = [
  // Identity
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
  // Calendar (read + write)
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Gmail (SENSITIVE only — send + label-apply)
  // Removed in Phase 1: gmail.readonly, gmail.modify (both RESTRICTED → CASA)
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  // Drive (narrow scope — only files Ari creates / opens via Picker)
  // Removed in Phase 1: drive.readonly, drive.metadata.readonly (both RESTRICTED)
  'https://www.googleapis.com/auth/drive.file'
];

// Extended scope bundles — granted on-demand when user first uses a heavier feature.
// `inbox` and `drive_full` bundles removed in Phase 1 (they only contained
// restricted scopes). The `drive` alias now resolves to drive.file alone.
const EXTENDED_SCOPES = {
  // Legacy alias — some existing callers pass 'drive'. Kept for back-compat
  // but now resolves to drive.file (sensitive) only.
  drive: [
    'https://www.googleapis.com/auth/drive.file'
  ],
  docs: [
    'https://www.googleapis.com/auth/drive.file'
  ],
  sheets: [
    'https://www.googleapis.com/auth/drive.file'
  ],
  slides: [
    'https://www.googleapis.com/auth/drive.file'
  ],
  tasks: [
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/tasks.readonly'
  ]
};

const HMAC_SECRET = process.env.COMPOSIO_USER_ID_SECRET || process.env.ENCRYPTION_KEY || process.env.GOOGLE_CLIENT_SECRET;
if (!HMAC_SECRET) {
  console.warn('WARNING: GOOGLE_CLIENT_SECRET not set — Google OAuth will not work');
}

class GoogleAuthService {
  useComposio() {
    return Boolean(composioConnector.isConfigured() && COMPOSIO_GOOGLE_PRODUCTS.some(
      product => this.getComposioAuthConfigId(product)
    ));
  }

  getComposioAuthConfigId(product) {
    const envName = COMPOSIO_AUTH_CONFIG_ENV[product];
    return envName ? process.env[envName] || null : null;
  }

  resolveComposioProduct(endpoint) {
    const url = String(endpoint || '').toLowerCase();
    if (url.includes('calendar')) return 'calendar';
    if (url.includes('tasks.googleapis.com')) return 'tasks';
    if (url.includes('docs.googleapis.com')) return 'docs';
    if (url.includes('sheets.googleapis.com')) return 'sheets';
    if (url.includes('slides.googleapis.com')) return 'slides';
    if (url.includes('drive.googleapis.com') || url.includes('/drive/')) return 'drive';
    if (url.includes('gmail.googleapis.com') || url.includes('/gmail/')) return 'gmail';
    if (url.includes('/oauth2/') || url.includes('openidconnect.googleapis.com')) return 'gmail';
    return null;
  }

  resolveComposioAuthConfigId(endpoint) {
    const product = this.resolveComposioProduct(endpoint);
    return product ? this.getComposioAuthConfigId(product) : null;
  }

  getRequiredScopes(scopeBundle) {
    return [...(EXTENDED_SCOPES[scopeBundle] || [])];
  }


  constructor() {
    this.tableCreated = false;
  }

  async ensureTable() {
    if (this.tableCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS google_tokens (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) UNIQUE NOT NULL,
          access_token_enc TEXT NOT NULL,
          refresh_token_enc TEXT,
          token_iv VARCHAR(64) NOT NULL,
          token_auth_tag VARCHAR(64) NOT NULL,
          refresh_iv VARCHAR(64),
          refresh_auth_tag VARCHAR(64),
          google_email VARCHAR(255),
          scopes TEXT,
          token_expiry TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_google_tokens_phone ON google_tokens(user_phone)`);
      this.tableCreated = true;
    } catch (error) {
      logger.error('Error creating google_tokens table:', error.message);
    }
  }

  createOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  generateStateParam(userPhone) {
    const payload = `${userPhone}:${Date.now()}`;
    const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
    const state = Buffer.from(`${payload}:${hmac}`).toString('base64url');
    return state;
  }

  validateStateParam(state) {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length < 3) return null;

      const hmac = parts.pop();
      const payload = parts.join(':');
      const [userPhone, timestamp] = payload.split(':');

      // Verify HMAC
      const expected = crypto.createHmac('sha256', HMAC_SECRET).update(`${userPhone}:${timestamp}`).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) {
        logger.security('oauth_state_tampered', { platform: 'google', userPhone });
        return null;
      }

      // Check expiry (10 minutes)
      if (Date.now() - parseInt(timestamp) > 10 * 60 * 1000) {
        logger.security('oauth_state_expired', { platform: 'google', userPhone });
        return null;
      }

      return userPhone;
    } catch (error) {
      logger.error('State validation error:', error.message);
      return null;
    }
  }

  async generateProductAuthUrl(userPhone, product, remaining = [], options = {}) {
    if (!COMPOSIO_GOOGLE_PRODUCTS.includes(product)) {
      throw new Error(`Unsupported Google product: ${product}`);
    }
    if (!this.useComposio()) return this.generateAuthUrl(userPhone);

    const authConfigId = this.getComposioAuthConfigId(product);
    if (!authConfigId) throw new Error(`${COMPOSIO_AUTH_CONFIG_ENV[product]} is not configured`);

    const callback = new URL(process.env.COMPOSIO_GOOGLE_CALLBACK_URL || process.env.GOOGLE_REDIRECT_URI);
    callback.searchParams.set('state', this.generateStateParam(userPhone));
    callback.searchParams.set('product', product);
    if (remaining.length) callback.searchParams.set('remaining', remaining.join(','));
    if (['dashboard', 'desktop'].includes(options.destination)) {
      callback.searchParams.set('destination', options.destination);
    }

    const request = await composioConnector.createConnectionLink({
      userPhone,
      authConfigId,
      callbackUrl: callback.toString(),
    });
    if (request.alreadyConnected && remaining.length) {
      const [next, ...rest] = remaining;
      return this.generateProductAuthUrl(userPhone, next, rest, options);
    }
    return request.redirectUrl || callback.toString();
  }

  async generateAuthUrl(userPhone, extraScopes = [], options = {}) {
    if (this.useComposio()) {
      const [first, ...remaining] = COMPOSIO_GOOGLE_PRODUCTS;
      return this.generateProductAuthUrl(userPhone, first, remaining, options);
    }

    const oauth2Client = this.createOAuth2Client();
    const state = this.generateStateParam(userPhone);

    const scopes = [...BASE_SCOPES, ...extraScopes];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
      include_granted_scopes: true
    });
  }

  async generateScopeUpgradeUrl(userPhone, scopeBundle) {
    if (this.useComposio()) return this.generateAuthUrl(userPhone);
    const extraScopes = EXTENDED_SCOPES[scopeBundle];
    if (!extraScopes) return null;

    const oauth2Client = this.createOAuth2Client();
    const state = this.generateStateParam(userPhone);

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...BASE_SCOPES, ...extraScopes],
      state,
      include_granted_scopes: true
    });
  }

  async handleCallback(code, state) {
    const userPhone = this.validateStateParam(state);
    if (!userPhone) {
      throw new Error('Invalid or expired authorization state');
    }

    const oauth2Client = this.createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Get user email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email;

    // Determine granted scopes
    const grantedScopes = tokens.scope || BASE_SCOPES.join(' ');

    // Encrypt tokens
    const accessEnc = encrypt(tokens.access_token);
    const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    await this.ensureTable();

    await query(`
      INSERT INTO google_tokens (
        user_phone, access_token_enc, token_iv, token_auth_tag,
        refresh_token_enc, refresh_iv, refresh_auth_tag,
        google_email, scopes, token_expiry, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (user_phone) DO UPDATE SET
        access_token_enc = $2, token_iv = $3, token_auth_tag = $4,
        refresh_token_enc = COALESCE($5, google_tokens.refresh_token_enc),
        refresh_iv = COALESCE($6, google_tokens.refresh_iv),
        refresh_auth_tag = COALESCE($7, google_tokens.refresh_auth_tag),
        google_email = $8, scopes = $9, token_expiry = $10, updated_at = NOW()
    `, [
      userPhone,
      accessEnc.encrypted, accessEnc.iv, accessEnc.authTag,
      refreshEnc?.encrypted || null, refreshEnc?.iv || null, refreshEnc?.authTag || null,
      googleEmail, grantedScopes,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null
    ]);

    return { userPhone, googleEmail, grantedScopes };
  }

  async hasScope(userPhone, scopeBundle) {
    if (this.useComposio()) {
      const product = ['tasks', 'docs', 'sheets', 'slides', 'drive'].includes(scopeBundle)
        ? scopeBundle
        : scopeBundle === 'inbox' ? 'gmail' : 'calendar';
      return this.isProductConnected(userPhone, product);
    }

    await this.ensureTable();
    const result = await query(
      `SELECT scopes FROM google_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    if (result.rows.length === 0) return false;

    const grantedScopes = result.rows[0].scopes || '';
    const requiredScopes = this.getRequiredScopes(scopeBundle);

    return requiredScopes.every(scope => grantedScopes.includes(scope));
  }

  /** Call when a connect flow completes so reads see the new connection now. */
  clearComposioNotConnected(userPhone) {
    composioConnector.clearNotConnected?.(userPhone);
  }

  async getAuthClient(userPhone) {
    if (this.useComposio()) {
      return composioConnector.createGoogleAuthClient({
        userPhone,
        resolveAuthConfigId: endpoint => this.resolveComposioAuthConfigId(endpoint),
      });
    }

    await this.ensureTable();

    // Apr 29 2026: replaced SELECT * with the explicit column list this
    // function actually uses. The google_tokens row carries large blobs
    // (encrypted token, IV, auth tag, scope JSON, raw response payload,
    // refresh-error trace) that we don't need 99% of the time, and the
    // pooler was returning all of them on every API call.
    const result = await query(
      `SELECT access_token_enc, token_iv, token_auth_tag,
              refresh_token_enc, refresh_iv, refresh_auth_tag,
              token_expiry
         FROM google_tokens
        WHERE user_phone = $1`,
      [userPhone]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const oauth2Client = this.createOAuth2Client();

    try {
      const accessToken = decrypt(row.access_token_enc, row.token_iv, row.token_auth_tag);

      const credentials = { access_token: accessToken };

      if (row.refresh_token_enc && row.refresh_iv && row.refresh_auth_tag) {
        credentials.refresh_token = decrypt(row.refresh_token_enc, row.refresh_iv, row.refresh_auth_tag);
      }

      if (row.token_expiry) {
        credentials.expiry_date = new Date(row.token_expiry).getTime();
      }

      oauth2Client.setCredentials(credentials);

      // Auto-refresh if expiring within 5 minutes.
      //
      // Apr 29 2026 — guarded with a per-user Postgres advisory lock (audit
      // 2.10). Two concurrent requests for the same user (e.g. a calendar
      // sync + an email summary firing in the same tick) used to BOTH call
      // refreshAccessToken — Google would invalidate the older refresh
      // token, the second UPDATE would clobber the first, and one of the
      // two flows would end up with a dead token until the next refresh.
      //
      // pg_try_advisory_lock returns false immediately if the lock is held;
      // when that happens we re-read the row to pick up whatever the other
      // caller wrote, instead of duplicating work.
      if (row.token_expiry && new Date(row.token_expiry).getTime() - Date.now() < 5 * 60 * 1000) {
        const lockKey = `ari:oauth:google:${userPhone}`;
        const lockId = _hashLockId(lockKey);
        const lockResp = await query(
          `SELECT pg_try_advisory_lock($1) AS got`,
          [lockId]
        );
        const gotLock = lockResp.rows[0]?.got === true;

        if (!gotLock) {
          // Another request is already refreshing for this user. Re-read
          // the row in 250ms — the other refresh will have updated it by
          // then in the common case.
          await new Promise(r => setTimeout(r, 250));
          const fresh = await query(
            `SELECT access_token_enc, token_iv, token_auth_tag, token_expiry
               FROM google_tokens WHERE user_phone = $1`,
            [userPhone]
          );
          if (fresh.rows[0]) {
            const r2 = fresh.rows[0];
            try {
              const newAccess = decrypt(r2.access_token_enc, r2.token_iv, r2.token_auth_tag);
              oauth2Client.setCredentials({
                access_token: newAccess,
                refresh_token: credentials.refresh_token,
                expiry_date: r2.token_expiry ? new Date(r2.token_expiry).getTime() : undefined
              });
            } catch (e) {
              logger.warn(`Token re-read after concurrent refresh failed for ${userPhone}: ${e.message}`);
            }
          }
        } else {
          try {
            const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
            const newAccessEnc = encrypt(refreshed.access_token);

            await query(`
              UPDATE google_tokens SET
                access_token_enc = $1, token_iv = $2, token_auth_tag = $3,
                token_expiry = $4, updated_at = NOW()
              WHERE user_phone = $5
            `, [
              newAccessEnc.encrypted, newAccessEnc.iv, newAccessEnc.authTag,
              refreshed.expiry_date ? new Date(refreshed.expiry_date) : null,
              userPhone
            ]);

            oauth2Client.setCredentials(refreshed);
          } catch (refreshError) {
            logger.warn(`Token refresh failed for ${userPhone}:`, refreshError.message);
            // Continue with existing token, it might still work
          } finally {
            // Release the advisory lock no matter what so the next caller
            // for this user isn't stuck waiting 250ms forever.
            await query(`SELECT pg_advisory_unlock($1)`, [lockId]).catch(() => {});
          }
        }
      }

      return oauth2Client;

    } catch (error) {
      logger.error(`Token decryption failed for ${userPhone}:`, error.message);
      return null;
    }
  }

  async isConnected(userPhone) {
    if (this.useComposio()) {
      const status = await this.getGoogleConnectionStatus(userPhone);
      return status.connected;
    }

    await this.ensureTable();
    const result = await query(
      `SELECT 1 FROM google_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rows.length > 0;
  }

  async isProductConnected(userPhone, product) {
    const authConfigId = this.getComposioAuthConfigId(product);
    if (!authConfigId) return false;
    return Boolean(await composioConnector.findActiveAccount({ userPhone, authConfigId }));
  }

  async getGoogleConnectionStatus(userPhone) {
    const entries = await Promise.all(COMPOSIO_GOOGLE_PRODUCTS.map(async product => [
      product,
      await this.isProductConnected(userPhone, product),
    ]));
    const products = Object.fromEntries(entries);
    return {
      connected: Object.values(products).some(Boolean),
      allConnected: Object.values(products).every(Boolean),
      products,
    };
  }

  async getGoogleEmail(userPhone) {
    if (this.useComposio()) {
      try {
        let product = null;
        for (const candidate of COMPOSIO_GOOGLE_PRODUCTS) {
          if (await this.isProductConnected(userPhone, candidate)) {
            product = candidate;
            break;
          }
        }
        if (!product) return null;
        const response = await composioConnector.proxyExecute({
          userPhone,
          authConfigId: this.getComposioAuthConfigId(product),
          endpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
          method: 'GET',
        });
        return response.data?.email || null;
      } catch (error) {
        logger.warn(`Could not resolve Composio Google email: ${error.message}`);
        return null;
      }
    }

    await this.ensureTable();
    const result = await query(
      `SELECT google_email FROM google_tokens WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rows[0]?.google_email || null;
  }

  async revokeTokens(userPhone) {
    if (this.useComposio()) {
      const results = await Promise.all(COMPOSIO_GOOGLE_PRODUCTS.map(product => composioConnector.disconnect({
        userPhone,
        authConfigId: this.getComposioAuthConfigId(product),
      }).catch(() => false)));
      return results.some(Boolean);
    }

    await this.ensureTable();

    const result = await query(
      `SELECT * FROM google_tokens WHERE user_phone = $1`,
      [userPhone]
    );

    if (result.rows.length === 0) return false;

    const row = result.rows[0];

    // Try to revoke at Google
    try {
      const accessToken = decrypt(row.access_token_enc, row.token_iv, row.token_auth_tag);
      const oauth2Client = this.createOAuth2Client();
      oauth2Client.setCredentials({ access_token: accessToken });
      await oauth2Client.revokeToken(accessToken);
    } catch (error) {
      logger.warn('Google token revocation failed (may already be revoked):', error.message);
    }

    // Delete from DB regardless
    await query(`DELETE FROM google_tokens WHERE user_phone = $1`, [userPhone]);
    return true;
  }

  async handleTokenError(userPhone, error) {
    const status = error.response?.status || error.code;

    if (status === 401 || error.message?.includes('invalid_grant') || error.message?.includes('Token has been revoked')) {
      logger.warn(`Token invalid for ${userPhone}, clearing tokens`);
      await query(`DELETE FROM google_tokens WHERE user_phone = $1`, [userPhone]);
      return {
        cleared: true,
        message: 'Your Google connection expired. Say "connect google" to reconnect.'
      };
    }

    return { cleared: false, message: null };
  }
}

module.exports = new GoogleAuthService();
