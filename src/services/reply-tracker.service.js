'use strict';

const { query } = require('../config/database');
const logger = require('../utils/logger');

const LOG_PREFIX = '[ReplyTracker]';

class ReplyTrackerService {
  constructor() {
    this.tableReady = false;
  }

  async ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS tracked_emails (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          gmail_message_id VARCHAR(100) NOT NULL,
          gmail_thread_id VARCHAR(100) NOT NULL,
          recipient_email VARCHAR(255) NOT NULL,
          recipient_name VARCHAR(255),
          subject TEXT,
          sent_at TIMESTAMP NOT NULL,
          wait_hours INTEGER DEFAULT 24,
          status VARCHAR(20) DEFAULT 'tracking',
          notified_at TIMESTAMP,
          reply_received_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_tracked_emails_user ON tracked_emails(user_phone, status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tracked_emails_status ON tracked_emails(status, sent_at)`);
      this.tableReady = true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Table creation error:`, error.message);
    }
  }

  /**
   * Start tracking an email for reply.
   */
  async trackEmail(userPhone, { messageId, threadId, recipientEmail, recipientName, subject, sentAt, waitHours }) {
    await this.ensureTable();

    // Avoid duplicate tracking for same message
    const { rows: existing } = await query(
      `SELECT id FROM tracked_emails WHERE gmail_message_id = $1 AND user_phone = $2`,
      [messageId, userPhone]
    );
    if (existing.length > 0) {
      logger.info(`${LOG_PREFIX} Already tracking message ${messageId} for ${userPhone}`);
      return existing[0].id;
    }

    const { rows } = await query(`
      INSERT INTO tracked_emails (user_phone, gmail_message_id, gmail_thread_id, recipient_email, recipient_name, subject, sent_at, wait_hours)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [userPhone, messageId, threadId, recipientEmail, recipientName || null, subject, sentAt, waitHours || 24]);

    logger.info(`${LOG_PREFIX} Tracking email "${subject}" to ${recipientEmail} for ${userPhone} (${waitHours}h)`);
    return rows[0].id;
  }

  /**
   * Get tracked emails that are past their wait window and haven't been notified yet.
   */
  async getTrackingDue() {
    await this.ensureTable();
    const { rows } = await query(`
      SELECT * FROM tracked_emails
      WHERE status = 'tracking'
        AND notified_at IS NULL
        AND NOW() > sent_at + (wait_hours * INTERVAL '1 hour')
      ORDER BY sent_at ASC
      LIMIT 50
    `);
    return rows;
  }

  /**
   * Get active tracked emails that might have early replies (within wait window).
   * Used by the cron to detect replies before the notification is due.
   */
  async getActiveTracking() {
    await this.ensureTable();
    const { rows } = await query(`
      SELECT * FROM tracked_emails
      WHERE status = 'tracking'
        AND sent_at > NOW() - INTERVAL '7 days'
      ORDER BY sent_at DESC
      LIMIT 50
    `);
    return rows;
  }

  /**
   * Mark as notified — user has been informed about no reply.
   */
  async markNotified(id) {
    await query(
      `UPDATE tracked_emails SET notified_at = NOW(), status = 'notified' WHERE id = $1`,
      [id]
    );
  }

  /**
   * Mark as replied — a reply was detected in the thread.
   */
  async markReplyReceived(id) {
    await query(
      `UPDATE tracked_emails SET reply_received_at = NOW(), status = 'replied' WHERE id = $1`,
      [id]
    );
  }

  /**
   * Cancel tracking for a specific email.
   */
  async cancelTracking(id, userPhone) {
    await query(
      `UPDATE tracked_emails SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`,
      [id, userPhone]
    );
  }

  /**
   * Get all active tracked emails for a user.
   */
  async getUserTrackedEmails(userPhone) {
    await this.ensureTable();
    const { rows } = await query(`
      SELECT * FROM tracked_emails
      WHERE user_phone = $1 AND status IN ('tracking', 'notified')
      ORDER BY sent_at DESC
      LIMIT 20
    `, [userPhone]);
    return rows;
  }
}

module.exports = new ReplyTrackerService();
