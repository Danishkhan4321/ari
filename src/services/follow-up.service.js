const { query } = require('../config/database');
const chrono = require('chrono-node');
const logger = require('../utils/logger');
const calendarNlpService = require('./calendar-nlp.service');

class FollowUpService {

  constructor() {
    this.tableReady = false;
  }

  // ========== SCHEMA ==========
  async ensureSchema() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS follow_ups (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          contact_name VARCHAR(255),
          contact_phone VARCHAR(50),
          subject TEXT NOT NULL,
          due_date TIMESTAMP,
          status VARCHAR(20) DEFAULT 'pending',
          priority VARCHAR(10) DEFAULT 'normal',
          notes TEXT,
          reminder_sent BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_follow_ups_user ON follow_ups(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(user_phone, status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(status, due_date, reminder_sent)`);
      this.tableReady = true;
    } catch (error) {
      logger.error('Error creating follow_ups table:', error.message);
    }
  }

  // ========== ADD FOLLOW-UP ==========
  async addFollowUp(userPhone, contactName, subject, dueDate = null, priority = 'normal', contactPhone = null) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO follow_ups (user_phone, contact_name, subject, due_date, priority, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userPhone, contactName || null, subject, dueDate || null, priority || 'normal', contactPhone || null]
      );
      logger.info(`Follow-up added for ${userPhone}: ${subject}`);
      return { success: true, followUp: result.rows[0] };
    } catch (error) {
      logger.error('Error adding follow-up:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET FOLLOW-UPS ==========
  async getFollowUps(userPhone, status = null) {
    await this.ensureSchema();
    try {
      let sql = `SELECT * FROM follow_ups WHERE user_phone = $1`;
      const params = [userPhone];

      if (status && status !== 'all') {
        sql += ` AND status = $2`;
        params.push(status);
      }

      sql += ` ORDER BY due_date ASC NULLS LAST, created_at DESC`;

      const result = await query(sql, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting follow-ups:', error.message);
      return [];
    }
  }

  // ========== COMPLETE FOLLOW-UP ==========
  async completeFollowUp(userPhone, followUpId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE follow_ups
         SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND user_phone = $2
         RETURNING *`,
        [followUpId, userPhone]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Follow-up not found.' };
      }
      return { success: true, followUp: result.rows[0] };
    } catch (error) {
      logger.error('Error completing follow-up:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== DELETE FOLLOW-UP ==========
  async deleteFollowUp(userPhone, followUpId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `DELETE FROM follow_ups WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [followUpId, userPhone]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Follow-up not found.' };
      }
      return { success: true, followUp: result.rows[0] };
    } catch (error) {
      logger.error('Error deleting follow-up:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET DUE FOLLOW-UPS (for cron job) ==========
  async getDueFollowUps() {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM follow_ups
         WHERE status = 'pending'
           AND due_date IS NOT NULL
           AND due_date <= NOW()
           AND reminder_sent = false
         ORDER BY due_date ASC`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting due follow-ups:', error.message);
      return [];
    }
  }

  // ========== MARK REMINDER SENT ==========
  async markReminderSent(followUpId, userPhone) {
    await this.ensureSchema();
    try {
      // IDOR fix (Batch F1): the userPhone-less branch was a legacy
      // signature used by the cron job (which legitimately knows the
      // row owner because it queried for due rows scoped by user).
      // It still works there, but callers who reach this without a
      // userPhone are now suspect — log and refuse. Pass the userPhone
      // the cron knows about; don't rely on a global flip.
      if (!userPhone) {
        logger.warn(`[FollowUp] markReminderSent called without userPhone for id=${followUpId} — refusing`);
        return false;
      }
      await query(
        `UPDATE follow_ups SET reminder_sent = true WHERE id = $1 AND user_phone = $2`,
        [followUpId, userPhone]
      );
      return true;
    } catch (error) {
      logger.error('Error marking reminder sent:', error.message);
      return false;
    }
  }

  /**
   * Resolve a typed due_time without reparsing the rest of the user message.
   * Explicitly offset ISO timestamps remain exact; local phrases are parsed in
   * the user's IANA timezone and biased toward the next future occurrence.
   */
  parseDueTime(value, timezone = 'Asia/Kolkata', referenceDate = new Date()) {
    const text = String(value || '').trim();
    if (!text) return null;

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const exact = new Date(text);
      return Number.isFinite(exact.getTime()) ? exact : null;
    }

    const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (!Number.isFinite(reference.getTime())) return null;
    const normalized = calendarNlpService.normalizeNonEnglishDates(text);
    const offset = calendarNlpService.getTimezoneOffsetMinutes(timezone || 'Asia/Kolkata');
    const parsed = chrono.parseDate(
      normalized,
      { instant: reference, timezone: offset },
      { forwardDate: true },
    );
    return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  // ========== PARSE FOLLOW-UP FROM TEXT ==========
  parseFollowUpFromText(text) {
    try {
      const original = text.trim();
      const lower = original.toLowerCase();

      // Extract contact name — patterns:
      // "follow up with Rahul about proposal"
      // "follow up with Dr. Sharma regarding deal"
      // "remind me to follow up with Emily on Friday"
      let contactName = null;
      let subject = null;
      let dueDate = null;

      // Try to extract: "follow up with [name] about/regarding/on [subject]"
      const withPattern = original.match(/(?:follow[\s-]?up|check[\s-]?in)\s+with\s+([A-Z][a-zA-Z.\s]+?)\s+(?:about|regarding|on|for|re)\s+(.+)/i);
      if (withPattern) {
        contactName = withPattern[1].trim();
        subject = withPattern[2].trim();
      }

      // Try: "follow up with [name]" (no subject after)
      if (!contactName) {
        const simpleWith = original.match(/(?:follow[\s-]?up|check[\s-]?in)\s+with\s+([A-Z][a-zA-Z.\s]+?)(?:\s+(?:on|by|in|tomorrow|today|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|$)/i);
        if (simpleWith) {
          contactName = simpleWith[1].trim();
        }
      }

      // Extract subject if not yet found
      if (!subject) {
        const aboutPattern = original.match(/(?:about|regarding|on|for|re)\s+(.+?)(?:\s+(?:on|by|in|tomorrow|today|next)\b|$)/i);
        if (aboutPattern) {
          subject = aboutPattern[1].trim();
        }
      }

      // Default subject if none extracted
      if (!subject) {
        // Use everything after "follow up" minus contact and date info
        subject = original
          .replace(/^(?:remind\s+me\s+to\s+)?(?:follow[\s-]?up|check[\s-]?in)\s*/i, '')
          .replace(/\bwith\s+[A-Z][a-zA-Z.\s]+?\b/i, '')
          .replace(/\b(?:on|by|in)\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|\d+\s+days?)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!subject || subject.length < 2) {
          subject = contactName ? `Follow up with ${contactName}` : 'Follow up';
        }
      }

      // Parse due date
      dueDate = this._parseDateFromText(lower);

      // Clean up contact name — remove trailing date words
      if (contactName) {
        contactName = contactName
          .replace(/\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i, '')
          .trim();
      }

      return {
        contactName: contactName || null,
        subject,
        dueDate
      };
    } catch (error) {
      logger.error('Error parsing follow-up text:', error.message);
      return { contactName: null, subject: text, dueDate: null };
    }
  }

  // ========== DATE PARSING HELPER ==========
  _parseDateFromText(text) {
    const now = new Date();

    // "today"
    if (/\btoday\b/i.test(text)) {
      const date = new Date(now);
      date.setHours(17, 0, 0, 0); // Default to 5 PM
      return date;
    }

    // "tomorrow"
    if (/\btomorrow\b/i.test(text)) {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0); // Default to 9 AM
      return date;
    }

    // "in X days"
    const inDaysMatch = text.match(/\bin\s+(\d+)\s+days?\b/i);
    if (inDaysMatch) {
      const date = new Date(now);
      date.setDate(date.getDate() + parseInt(inDaysMatch[1]));
      date.setHours(9, 0, 0, 0);
      return date;
    }

    // "in X hours"
    const inHoursMatch = text.match(/\bin\s+(\d+)\s+hours?\b/i);
    if (inHoursMatch) {
      const date = new Date(now);
      date.setHours(date.getHours() + parseInt(inHoursMatch[1]));
      return date;
    }

    // "next week"
    if (/\bnext\s+week\b/i.test(text)) {
      const date = new Date(now);
      date.setDate(date.getDate() + (7 - date.getDay() + 1)); // Next Monday
      date.setHours(9, 0, 0, 0);
      return date;
    }

    // Day of week: "on Monday", "on Friday", "tuesday", etc.
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayMatch = text.match(/\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (dayMatch) {
      const targetDay = days.indexOf(dayMatch[1].toLowerCase());
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      // Same-day names ("on Friday" said Friday morning) mean TODAY while
      // the default 9 AM slot is still ahead — matches the weekly-reminder
      // semantics in reminder.service.js. Roll to next week only when the
      // day has passed or today's 9 AM already has.
      if (daysUntil < 0 || (daysUntil === 0 && now.getHours() >= 9)) daysUntil += 7;
      const date = new Date(now);
      date.setDate(date.getDate() + daysUntil);
      date.setHours(9, 0, 0, 0);
      return date;
    }

    return null;
  }
}

module.exports = new FollowUpService();
