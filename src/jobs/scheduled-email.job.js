const cron = require('node-cron');
const { query } = require('../config/database');
const gmailService = require('../services/gmail.service');
const googleAuthService = require('../services/google-auth.service');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const salesService = require('../services/sales.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class ScheduledEmailJob {

  constructor() {
    this.tableReady = false;
    this.isRunning = false;
  }

  async ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS scheduled_emails (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          recipients TEXT[] NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          html_body TEXT NOT NULL,
          send_at TIMESTAMP NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          lead_id INTEGER,
          email_type VARCHAR(30),
          sent_at TIMESTAMP,
          error TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_emails_user ON scheduled_emails(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status ON scheduled_emails(status, send_at)`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS recurrence_pattern VARCHAR(20)`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS recurrence_days VARCHAR(50)`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS recurrence_time VARCHAR(10)`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS timezone VARCHAR(80)`);
      await query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS attachments_json JSONB`);
      this.tableReady = true;
    } catch (error) {
      this.tableReady = true;
    }
  }

  getZonedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const parts = dtf.formatToParts(date);
    const map = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return {
      year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day),
      hour: parseInt(map.hour), minute: parseInt(map.minute), second: parseInt(map.second)
    };
  }

  zonedWallTimeToUtcDate({ year, month, day, hour, minute, second = 0 }, timeZone) {
    const desiredTotalMinutes = ((day * 24 + hour) * 60) + minute;
    let guessMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    for (let i = 0; i < 2; i++) {
      const actual = this.getZonedParts(new Date(guessMs), timeZone);
      const actualTotalMinutes = ((actual.day * 24 + actual.hour) * 60) + actual.minute;
      const deltaMinutes = desiredTotalMinutes - actualTotalMinutes;
      if (deltaMinutes === 0) break;
      guessMs += deltaMinutes * 60 * 1000;
    }
    return new Date(guessMs);
  }

  addDaysInZone(parts, daysToAdd, timeZone) {
    const noonUtc = this.zonedWallTimeToUtcDate(
      { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0, second: 0 }, timeZone
    );
    const shifted = new Date(noonUtc.getTime() + daysToAdd * 86400000);
    const newLocal = this.getZonedParts(shifted, timeZone);
    return { year: newLocal.year, month: newLocal.month, day: newLocal.day };
  }

  computeNextRecurringSendAt(email) {
    const tz = email.timezone || 'Asia/Kolkata';
    const time = email.recurrence_time || '09:00';
    const [hours, minutes] = time.split(':').map(n => parseInt(n || '0'));

    const nowLocal = this.getZonedParts(new Date(), tz);
    let targetDate = this.addDaysInZone(nowLocal, 1, tz);

    const pattern = (email.recurrence_pattern || '').toLowerCase();
    if (pattern === 'weekly') {
      targetDate = this.addDaysInZone(nowLocal, 7, tz);
    } else if (pattern === 'weekdays' || pattern === 'custom') {
      const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const allowed = (email.recurrence_days || '').split(',').map(d => dayMap[d.trim().slice(0, 3).toLowerCase()]).filter(d => d !== undefined);
      const allowedDays = allowed.length ? allowed : [1, 2, 3, 4, 5];
      for (let i = 1; i <= 14; i++) {
        const d = this.addDaysInZone(nowLocal, i, tz);
        const dow = new Date(Date.UTC(d.year, d.month - 1, d.day, 12, 0, 0)).getUTCDay();
        if (allowedDays.includes(dow)) {
          targetDate = d;
          break;
        }
      }
    } else if (pattern === 'weekends') {
      for (let i = 1; i <= 14; i++) {
        const d = this.addDaysInZone(nowLocal, i, tz);
        const dow = new Date(Date.UTC(d.year, d.month - 1, d.day, 12, 0, 0)).getUTCDay();
        if (dow === 0 || dow === 6) {
          targetDate = d;
          break;
        }
      }
    }

    return this.zonedWallTimeToUtcDate(
      { ...targetDate, hour: Number.isFinite(hours) ? hours : 9, minute: Number.isFinite(minutes) ? minutes : 0, second: 0 },
      tz
    );
  }

  async start() {
    await this.ensureTable();

    // Check every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
      try {
        await this.checkAndSendEmails();
      } catch (error) {
        logger.error('Scheduled email job error:', error.message);
      }
    });

    logger.info('Scheduled email job started - checking every 30 seconds');
  }

  async checkAndSendEmails() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const result = await query(
        `SELECT * FROM scheduled_emails
         WHERE status = 'pending' AND send_at <= NOW()
         ORDER BY send_at ASC LIMIT 20`
      );

      if (result.rows.length === 0) return;

      logger.info(`Sending ${result.rows.length} scheduled email(s)`);

      for (const email of result.rows) {
        await this.sendScheduledEmail(email);
      }
    } catch (error) {
      logger.error('Check scheduled emails error:', error.message);
    } finally {
      this.isRunning = false;
    }
  }

  async sendScheduledEmail(email) {
    try {
      // Verify Google is still connected
      if (!await googleAuthService.isConnected(email.user_phone)) {
        await query(
          `UPDATE scheduled_emails SET status = 'failed', error = 'Google disconnected' WHERE id = $1`,
          [email.id]
        );
        const failNotifyId = await accountLinkService.getNotifyUserId(email.user_phone);
        const failNotification = `Scheduled email failed - Google account disconnected.\nSubject: "${email.subject}"\nTo: ${email.recipients.join(', ')}`;
        await sendWithTemplateFallback(failNotifyId, failNotification, TEMPLATES.SCHEDULED_EMAIL, [email.subject, 'failed', email.recipients?.join(', ') || 'recipients']);
        return;
      }

      let attachments = [];
      if (email.attachments_json && Array.isArray(email.attachments_json)) {
        attachments = email.attachments_json
          .map(a => {
            if (!a || !a.base64) return null;
            return {
              fileName: a.fileName || 'attachment',
              mimeType: a.mimeType || 'application/octet-stream',
              buffer: Buffer.from(a.base64, 'base64')
            };
          })
          .filter(Boolean);
      }

      // Send to each recipient individually
      let successCount = 0;
      let failCount = 0;
      const failedRecipients = [];

      for (const recipient of email.recipients) {
        try {
          const result = await gmailService.sendEmail(email.user_phone, {
            to: recipient,
            subject: email.subject,
            htmlBody: email.html_body,
            attachments
          });

          if (result.success) {
            successCount++;

            // Log to sales_emails_log if it's a sales email
            if (email.lead_id) {
              try {
                await query(
                  `INSERT INTO sales_emails_log (user_phone, lead_id, email_type, subject, gmail_message_id)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [email.user_phone, email.lead_id, email.email_type || 'scheduled', email.subject, result.messageId]
                );
              } catch (e) { /* non-critical */ }
            }
          } else {
            failCount++;
            failedRecipients.push(recipient);
          }
        } catch (err) {
          failCount++;
          failedRecipients.push(recipient);
          logger.error(`Failed to send to ${recipient}:`, err.message);
        }
      }

      // Update status (and next run for recurring)
      const status = failCount === 0 ? 'sent' : (successCount === 0 ? 'failed' : 'partial');
      const errorMsg = failedRecipients.length > 0 ? `Failed: ${failedRecipients.join(', ')}` : null;
      const isRecurring = Boolean(email.is_recurring);
      let nextSendAt = null;
      if (isRecurring && successCount > 0) {
        nextSendAt = this.computeNextRecurringSendAt(email);
        await query(
          `UPDATE scheduled_emails SET status = 'pending', sent_at = NOW(), send_at = $1, error = $2 WHERE id = $3`,
          [nextSendAt.toISOString(), errorMsg, email.id]
        );
      } else {
        await query(
          `UPDATE scheduled_emails SET status = $1, sent_at = NOW(), error = $2 WHERE id = $3`,
          [status, errorMsg, email.id]
        );
      }

      // Notify user on preferred platform
      const notifyUserId = await accountLinkService.getNotifyUserId(email.user_phone);
      const totalRecipients = email.recipients.length;
      let notification;
      if (isRecurring && successCount > 0) {
        const nextRun = nextSendAt ? nextSendAt.toLocaleString('en-IN', {
          day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
        }) : 'N/A';
        notification = `*Recurring email sent*\nSubject: "${email.subject}"\nSent: ${successCount}/${totalRecipients}\nNext: ${nextRun} (${email.timezone || 'local'})`;
        if (failedRecipients.length) notification += `\nFailed: ${failedRecipients.join(', ')}`;
      } else if (status === 'sent') {
        notification = `*Scheduled email sent!*\nSubject: "${email.subject}"\nTo: ${email.recipients.join(', ')}`;
      } else if (status === 'partial') {
        notification = `*Scheduled email partially sent*\nSubject: "${email.subject}"\nSent: ${successCount}/${totalRecipients}\nFailed: ${failedRecipients.join(', ')}`;
      } else {
        notification = `*Scheduled email failed*\nSubject: "${email.subject}"\nTo: ${email.recipients.join(', ')}\n\nTry resending manually.`;
      }

      await sendWithTemplateFallback(notifyUserId, notification, TEMPLATES.SCHEDULED_EMAIL, [email.subject, status, email.recipients?.join(', ') || 'recipients']);
      logger.info(`Scheduled email #${email.id}: ${status} (${successCount}/${totalRecipients})`);

    } catch (error) {
      logger.error(`Scheduled email #${email.id} error:`, error.message);
      await query(
        `UPDATE scheduled_emails SET status = 'failed', error = $1 WHERE id = $2`,
        [error.message, email.id]
      );
    }
  }

  serializeAttachments(attachments) {
    const serializedAttachments = Array.isArray(attachments) && attachments.length > 0
      ? attachments.map(a => ({
        fileName: a.fileName || 'attachment',
        mimeType: a.mimeType || 'application/octet-stream',
        base64: Buffer.isBuffer(a.buffer) ? a.buffer.toString('base64') : null
      })).filter(a => a.base64)
      : null;

    return serializedAttachments && serializedAttachments.length > 0
      ? JSON.stringify(serializedAttachments)
      : null;
  }

  // ========== SCHEDULE AN EMAIL ==========
  async scheduleEmail(userPhone, { recipients, subject, body, htmlBody, sendAt, leadId, emailType, isRecurring = false, recurrencePattern = null, recurrenceDays = null, recurrenceTime = null, timezone = null, attachments = null }) {
    await this.ensureTable();
    try {
      const attachmentsJson = this.serializeAttachments(attachments);
      const result = await query(
        `INSERT INTO scheduled_emails (
          user_phone, recipients, subject, body, html_body, send_at, lead_id, email_type,
          is_recurring, recurrence_pattern, recurrence_days, recurrence_time, timezone, attachments_json
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) RETURNING *`,
        [
          userPhone, recipients, subject, body, htmlBody, sendAt.toISOString(), leadId || null, emailType || null,
          isRecurring, recurrencePattern, recurrenceDays, recurrenceTime, timezone, attachmentsJson
        ]
      );
      return { success: true, scheduled: result.rows[0] };
    } catch (error) {
      logger.error('Schedule email error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== VIEW SCHEDULED EMAILS ==========
  async getScheduledEmails(userPhone) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT * FROM scheduled_emails
         WHERE user_phone = $1 AND status = 'pending'
         ORDER BY send_at ASC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async updateScheduledEmailsByIds(userPhone, emailIds, {
    sendAt,
    timezone = null,
    isRecurring = false,
    recurrencePattern = null,
    recurrenceDays = null,
    recurrenceTime = null
  }) {
    await this.ensureTable();
    const normalizedIds = [...new Set(
      (Array.isArray(emailIds) ? emailIds : [])
        .map(id => Number.parseInt(id, 10))
        .filter(Number.isInteger)
    )];

    if (normalizedIds.length === 0) {
      return { success: false, error: 'No scheduled emails found to update.' };
    }

    try {
      const result = await query(
        `UPDATE scheduled_emails
         SET send_at = $1,
             timezone = $2,
             is_recurring = $3,
             recurrence_pattern = $4,
             recurrence_days = $5,
             recurrence_time = $6
         WHERE user_phone = $7
           AND id = ANY($8::int[])
           AND status = 'pending'
         RETURNING *`,
        [
          sendAt.toISOString(),
          timezone,
          Boolean(isRecurring),
          recurrencePattern,
          recurrenceDays,
          recurrenceTime,
          userPhone,
          normalizedIds
        ]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Scheduled email not found or already sent.' };
      }

      return { success: true, emails: result.rows };
    } catch (error) {
      logger.error('Update scheduled emails error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== CANCEL SCHEDULED EMAIL ==========
  async cancelScheduledEmail(userPhone, emailId) {
    await this.ensureTable();
    try {
      const result = await query(
        `UPDATE scheduled_emails SET status = 'cancelled'
         WHERE id = $1 AND user_phone = $2 AND status = 'pending' RETURNING *`,
        [emailId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Scheduled email not found or already sent.' };
      return { success: true, email: result.rows[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new ScheduledEmailJob();


