const { query } = require('../config/database');
const crypto = require('crypto');
const BoundedMap = require('../utils/bounded-map');
const { isLinkCodeLimited } = require('../middleware/abuse-protection');
const logger = require('../utils/logger');

class AccountLinkService {

  constructor() {
    this.linkCodesReady = false;
    this.linkedAccountsReady = false;
    // In-memory cache: userId → primary userId (bounded, auto-expiring)
    this.linkCache = new BoundedMap(20000, 5 * 60 * 1000); // 5 min TTL
  }

  // ========== SCHEMA ==========
  async ensureLinkCodesTable() {
    if (this.linkCodesReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS link_codes (
          id SERIAL PRIMARY KEY,
          code VARCHAR(10) NOT NULL UNIQUE,
          user_id VARCHAR(50) NOT NULL,
          platform VARCHAR(20) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          used BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code)`);
      await query(`DELETE FROM link_codes WHERE expires_at < NOW() - INTERVAL '1 hour'`);
      this.linkCodesReady = true;
    } catch (error) {
      logger.error('ensureLinkCodesTable error:', error.message);
    }
  }

  async ensureLinkedAccountsTable() {
    if (this.linkedAccountsReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS linked_accounts (
          id SERIAL PRIMARY KEY,
          primary_user_id VARCHAR(50) NOT NULL,
          platform_user_id VARCHAR(50) NOT NULL UNIQUE,
          platform VARCHAR(20) NOT NULL,
          display_name VARCHAR(100),
          is_primary BOOLEAN DEFAULT false,
          notify_platform VARCHAR(20),
          linked_at TIMESTAMP DEFAULT NOW()
        )
      `);
      const cols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'linked_accounts'
           AND column_name IN ('primary_user_id', 'platform_user_id')`
      );
      if (cols.rows.length === 2) {
        await query(`CREATE INDEX IF NOT EXISTS idx_linked_primary ON linked_accounts(primary_user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_linked_platform ON linked_accounts(platform_user_id)`);
      } else {
        logger.warn('linked_accounts has legacy schema — skipping index creation');
      }
      this.linkedAccountsReady = true;
    } catch (error) {
      logger.warn('ensureLinkedAccountsTable error:', error.message);
      this.linkedAccountsReady = true;
    }
  }

  async ensureTable() {
    // link_codes first — dashboard magic-link must work even if linked_accounts
    // predates the WhatsApp-only schema (baseline migration used primary_phone).
    await this.ensureLinkCodesTable();
    await this.ensureLinkedAccountsTable();
  }

  // ========== RESOLVE USER ID ==========
  // Given any platform userId, return the primary userId (for data access)
  // If not linked, returns the same userId back
  async getPrimaryUserId(userId) {
    // Check cache (BoundedMap handles TTL)
    const cached = this.linkCache.get(userId);
    if (cached) return cached;

    await this.ensureTable();
    try {
      const result = await query(
        `SELECT primary_user_id FROM linked_accounts WHERE platform_user_id = $1`,
        [userId]
      );

      const primaryId = result.rows.length > 0 ? result.rows[0].primary_user_id : userId;
      this.linkCache.set(userId, primaryId);
      return primaryId;
    } catch (error) {
      return userId;
    }
  }

  // ========== GET NOTIFICATION USER ID ==========
  // Given a primary userId, return which platform userId should get notifications
  async getNotifyUserId(primaryUserId) {
    await this.ensureTable();
    try {
      // Check if there's a preferred notification platform
      const result = await query(
        `SELECT platform_user_id, platform, notify_platform
         FROM linked_accounts
         WHERE primary_user_id = $1
         ORDER BY is_primary DESC, linked_at ASC`,
        [primaryUserId]
      );

      if (result.rows.length === 0) return primaryUserId;

      // Find the row with notify_platform set, or the primary
      const preferred = result.rows.find(r => r.notify_platform === r.platform);
      if (preferred) return preferred.platform_user_id;

      // Fall back to primary account
      const primary = result.rows.find(r => r.is_primary);
      if (primary) return primary.platform_user_id;

      return result.rows[0].platform_user_id;
    } catch (error) {
      return primaryUserId;
    }
  }

  // ========== GET ALL LINKED ACCOUNTS ==========
  async getLinkedAccounts(userId) {
    const primaryId = await this.getPrimaryUserId(userId);
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT * FROM linked_accounts WHERE primary_user_id = $1 ORDER BY is_primary DESC, linked_at ASC`,
        [primaryId]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== GENERATE LINK CODE ==========
  // User on platform A says "link discord" → generate a code to enter on Discord
  async generateLinkCode(userId, platform) {
    await this.ensureTable();

    // Ensure current user is registered as a linked account (self-link)
    await this.ensureSelfLinked(userId);

    // Generate 6-char alphanumeric code
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    try {
      // Delete any existing unused codes for this user
      await query(
        `DELETE FROM link_codes WHERE user_id = $1 AND used = false`,
        [userId]
      );

      await query(
        `INSERT INTO link_codes (code, user_id, platform, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [code, userId, platform, expiresAt.toISOString()]
      );

      return { success: true, code, expiresIn: '10 minutes' };
    } catch (error) {
      logger.error('Generate link code error:', error.message);
      return { success: false, error: 'Could not generate link code.' };
    }
  }

  // ========== CLAIM LINK CODE ==========
  // User on platform B says "link ABCDEF" → link their account
  async claimLinkCode(newUserId, code, newPlatform, displayName) {
    await this.ensureTable();

    // Brute-force protection: max 5 attempts per user per hour
    if (isLinkCodeLimited(newUserId)) {
      return { success: false, error: 'Too many link attempts. Please wait before trying again.' };
    }

    try {
      // Find valid code
      const result = await query(
        `SELECT * FROM link_codes
         WHERE code = $1 AND used = false AND expires_at > NOW()`,
        [code.toUpperCase()]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Invalid or expired code. Generate a new one.' };
      }

      const linkCode = result.rows[0];
      const primaryId = await this.getPrimaryUserId(linkCode.user_id);

      // Check if newUserId is already linked to someone else
      const existing = await query(
        `SELECT primary_user_id FROM linked_accounts WHERE platform_user_id = $1`,
        [newUserId]
      );
      if (existing.rows.length > 0 && existing.rows[0].primary_user_id !== primaryId) {
        return { success: false, error: 'This account is already linked to a different Ari account. Unlink it first.' };
      }

      // Link the new platform account
      await query(
        `INSERT INTO linked_accounts (primary_user_id, platform_user_id, platform, display_name, is_primary)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (platform_user_id) DO UPDATE SET primary_user_id = $1, display_name = $4`,
        [primaryId, newUserId, newPlatform, displayName]
      );

      // Mark code as used
      await query(`UPDATE link_codes SET used = true WHERE id = $1`, [linkCode.id]);

      // Clear cache
      this.linkCache.delete(newUserId);

      logger.info(`Account linked: ${newUserId} (${newPlatform}) → primary ${primaryId}`);
      return { success: true, primaryId };
    } catch (error) {
      logger.error('Claim link code error:', error.message);
      return { success: false, error: 'Could not link account.' };
    }
  }

  // ========== ENSURE SELF-LINKED ==========
  // Make sure the user has a linked_accounts row for themselves
  async ensureSelfLinked(userId) {
    await this.ensureTable();
    try {
      const existing = await query(
        `SELECT id FROM linked_accounts WHERE platform_user_id = $1`,
        [userId]
      );

      if (existing.rows.length === 0) {
        const platform = this.detectPlatform(userId);
        await query(
          `INSERT INTO linked_accounts (primary_user_id, platform_user_id, platform, is_primary, notify_platform)
           VALUES ($1, $1, $2, true, $2)
           ON CONFLICT (platform_user_id) DO NOTHING`,
          [userId, platform]
        );
      }
    } catch (error) {
      // Non-critical
    }
  }

  // ========== SET NOTIFICATION PLATFORM ==========
  async setNotifyPlatform(userId, platform) {
    const primaryId = await this.getPrimaryUserId(userId);
    await this.ensureTable();
    try {
      // Clear all notify_platform for this user
      await query(
        `UPDATE linked_accounts SET notify_platform = NULL WHERE primary_user_id = $1`,
        [primaryId]
      );

      // Set the chosen one
      const result = await query(
        `UPDATE linked_accounts SET notify_platform = $1
         WHERE primary_user_id = $2 AND platform = $1 RETURNING *`,
        [platform, primaryId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: `No ${platform} account linked. Link it first.` };
      }

      return { success: true, platform };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== UNLINK ACCOUNT ==========
  async unlinkPlatform(userId, platform) {
    const primaryId = await this.getPrimaryUserId(userId);
    await this.ensureTable();
    try {
      // Don't allow unlinking the primary account
      const target = await query(
        `SELECT * FROM linked_accounts
         WHERE primary_user_id = $1 AND platform = $2`,
        [primaryId, platform]
      );

      if (target.rows.length === 0) {
        return { success: false, error: `No ${platform} account linked.` };
      }

      if (target.rows[0].is_primary) {
        return { success: false, error: `Can't unlink your primary platform. Change primary first.` };
      }

      await query(
        `DELETE FROM linked_accounts
         WHERE primary_user_id = $1 AND platform = $2 AND is_primary = false`,
        [primaryId, platform]
      );

      // Clear cache for the unlinked userId
      this.linkCache.delete(target.rows[0].platform_user_id);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== DETECT PLATFORM FROM USER ID ==========
  detectPlatform(userId) {
    if (userId.startsWith('wa_')) return 'whatsapp';
    if (userId.startsWith('dc_')) return 'discord';
    if (userId.startsWith('tg_')) return 'telegram';
    if (userId.startsWith('sl_')) return 'slack';
    if (userId.startsWith('gc_')) return 'gchat';
    if (/^\d+$/.test(userId)) return 'whatsapp';
    return 'unknown';
  }

  platformLabel(platform) {
    const labels = {
      whatsapp: 'WhatsApp', discord: 'Discord', telegram: 'Telegram',
      slack: 'Slack', gchat: 'Google Chat'
    };
    return labels[platform] || platform;
  }

  // ========== FORMAT LINKED ACCOUNTS FOR DISPLAY ==========
  formatLinkedAccounts(accounts) {
    if (!accounts || accounts.length === 0) {
      return 'No linked accounts.\n\nLink one: _"link discord"_ or _"link telegram"_';
    }

    let text = '*Linked Accounts*\n\n';
    for (const acc of accounts) {
      const primary = acc.is_primary ? ' (primary)' : '';
      const notify = acc.notify_platform === acc.platform ? ' -- notifications here' : '';
      text += `- *${this.platformLabel(acc.platform)}*${primary}${notify}`;
      if (acc.display_name) text += ` (${acc.display_name})`;
      text += '\n';
    }

    text += '\n_"set notifications to discord" to change_';
    text += '\n_"unlink telegram" to remove_';
    return text;
  }
}

module.exports = new AccountLinkService();
