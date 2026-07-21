'use strict';

const { query } = require('../config/database');
const logger = require('../utils/logger');

const LOG_PREFIX = '[EmailPrefs]';

class EmailPreferencesService {
  constructor() {
    this.tableReady = false;
  }

  async ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS email_preferences (
          user_phone VARCHAR(20) PRIMARY KEY,
          auto_label_enabled BOOLEAN DEFAULT FALSE,
          reply_tracking_enabled BOOLEAN DEFAULT TRUE,
          reply_tracking_hours INTEGER DEFAULT 24,
          last_labeled_email_ts TIMESTAMP,
          last_labeled_email_id VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      this.tableReady = true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Table creation error:`, error.message);
    }
  }

  /**
   * Get preferences for a user. Returns defaults if no row exists.
   */
  async getPreferences(userPhone) {
    await this.ensureTable();
    const { rows } = await query(
      `SELECT * FROM email_preferences WHERE user_phone = $1`,
      [userPhone]
    );
    if (rows.length > 0) return rows[0];

    // Return defaults (don't insert — only create row when user enables something)
    return {
      user_phone: userPhone,
      auto_label_enabled: false,
      reply_tracking_enabled: true,
      reply_tracking_hours: 24,
      last_labeled_email_ts: null,
      last_labeled_email_id: null,
    };
  }

  /**
   * Toggle auto-labeling on/off.
   */
  async setAutoLabel(userPhone, enabled) {
    await this.ensureTable();
    await query(`
      INSERT INTO email_preferences (user_phone, auto_label_enabled, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_phone)
      DO UPDATE SET auto_label_enabled = $2, updated_at = NOW()
    `, [userPhone, enabled]);
    logger.info(`${LOG_PREFIX} Auto-label ${enabled ? 'enabled' : 'disabled'} for ${userPhone}`);
  }

  /**
   * Toggle reply tracking and set wait hours.
   */
  async setReplyTracking(userPhone, enabled, hours = 24) {
    await this.ensureTable();
    await query(`
      INSERT INTO email_preferences (user_phone, reply_tracking_enabled, reply_tracking_hours, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_phone)
      DO UPDATE SET reply_tracking_enabled = $2, reply_tracking_hours = $3, updated_at = NOW()
    `, [userPhone, enabled, hours]);
    logger.info(`${LOG_PREFIX} Reply tracking ${enabled ? 'enabled' : 'disabled'} (${hours}h) for ${userPhone}`);
  }

  /**
   * Update the watermark — last email that was auto-labeled.
   */
  async updateLastLabeledEmail(userPhone, emailId, timestamp) {
    await this.ensureTable();
    await query(`
      UPDATE email_preferences
      SET last_labeled_email_ts = $2, last_labeled_email_id = $3, updated_at = NOW()
      WHERE user_phone = $1
    `, [userPhone, timestamp, emailId]);
  }

  /**
   * Get all users who have auto-labeling enabled AND have a valid Google connection.
   */
  async getAutoLabelUsers() {
    await this.ensureTable();
    const { rows } = await query(`
      SELECT ep.user_phone, ep.last_labeled_email_ts, ep.last_labeled_email_id
      FROM email_preferences ep
      INNER JOIN google_tokens gt ON ep.user_phone = gt.user_phone
      WHERE ep.auto_label_enabled = TRUE
    `);
    return rows;
  }
}

module.exports = new EmailPreferencesService();
