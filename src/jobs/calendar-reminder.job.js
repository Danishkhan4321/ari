const cron = require('node-cron');
const { query } = require('../config/database');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const googleAuthService = require('../services/google-auth.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class CalendarReminderJob {

  constructor() {
    this.settingsTableCreated = false;
    this.isRunningReminders = false;
    this.isRunningSync = false;
  }

  async ensureSettingsTable() {
    if (this.settingsTableCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS calendar_sync_settings (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) UNIQUE NOT NULL,
          sync_enabled BOOLEAN DEFAULT false,
          remind_all_meetings BOOLEAN DEFAULT false,
          default_reminder_minutes INTEGER DEFAULT 15,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      this.settingsTableCreated = true;
    } catch (error) {
      logger.error('Error creating calendar_sync_settings table:', error.message);
    }
  }

  start() {
    // Check and send reminders every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
      try {
        await this.checkAndSendReminders();
      } catch (error) {
        logger.error('Calendar reminder job error:', error.message);
      }
    });

    // Sync upcoming events for opted-in users every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      try {
        await this.runSyncForAllUsers();
      } catch (error) {
        logger.error('Calendar sync job error:', error.message);
      }
    });

    logger.info('Calendar reminder job started');
  }

  async checkAndSendReminders() {
    if (this.isRunningReminders) return;
    this.isRunningReminders = true;
    try {
      // Ensure calendar tables exist (lazy creation via calendar service)
      const calendarService = require('../services/calendar.service');
      await calendarService.ensureTables();

      const result = await query(
        `SELECT * FROM calendar_reminders
         WHERE status = 'pending'
         AND reminder_time <= NOW()
         ORDER BY reminder_time ASC
         LIMIT 20`
      );

      for (const reminder of result.rows) {
        try {
          const eventStart = new Date(reminder.event_start);
          const minsUntil = Math.round((eventStart - new Date()) / 60000);

          // Cross-table dedup: if the user also set a MANUAL reminder that
          // fires within ±2 minutes of this calendar reminder, suppress the
          // auto one. Users who type "remind me about the X meeting at 2:45"
          // were getting two near-identical pings: their manual reminder +
          // this auto-generated calendar one. The manual reminder is more
          // specific (user-chosen text/time), so it wins.
          try {
            const dup = await query(
              `SELECT 1 FROM reminders
                WHERE user_phone = $1
                  AND status = 'pending'
                  AND ABS(EXTRACT(EPOCH FROM (reminder_time - $2))) < 120
                LIMIT 1`,
              [reminder.user_phone, reminder.reminder_time]
            );
            if (dup.rows.length > 0) {
              logger.info(`[CalendarReminder] Skipping calendar reminder ${reminder.id} for ${reminder.user_phone} — manual reminder within 2 min`);
              await query(
                `UPDATE calendar_reminders SET status = 'suppressed' WHERE id = $1`,
                [reminder.id]
              );
              continue;
            }
          } catch (dupErr) {
            // Dedup is best-effort; fall through to send if it errors.
            logger.warn(`[CalendarReminder] dedup query failed: ${dupErr.message}`);
          }

          const timeStr = eventStart.toLocaleTimeString('en-IN', {
            hour: 'numeric', minute: '2-digit', hour12: true
          });

          let message = `*Meeting Reminder*\n\n`;
          message += `${reminder.event_title || 'Upcoming meeting'}\n`;
          if (minsUntil > 0) {
            message += `Starts in ${minsUntil} minute${minsUntil !== 1 ? 's' : ''} (${timeStr})`;
          } else {
            message += `Starting now (${timeStr})`;
          }

          const notifyUserId = await accountLinkService.getNotifyUserId(reminder.user_phone);
          const eventTitle = reminder.event_title || 'Meeting';
          const timeUntil = minsUntil > 0 ? `${minsUntil} minute${minsUntil !== 1 ? 's' : ''}` : '0 minutes';
          const joinLink = '';
          await sendWithTemplateFallback(notifyUserId, message, TEMPLATES.MEETING_REMINDER, [eventTitle, timeUntil, joinLink]);

          await query(
            `UPDATE calendar_reminders SET status = 'sent' WHERE id = $1`,
            [reminder.id]
          );

        } catch (sendError) {
          logger.error(`Failed to send calendar reminder ${reminder.id}:`, sendError.message);
          // Mark as failed after too many attempts
          await query(
            `UPDATE calendar_reminders SET status = 'failed' WHERE id = $1`,
            [reminder.id]
          );
        }
      }
    } catch (error) {
      // Table might not exist yet
      if (!error.message.includes('does not exist')) {
        logger.error('checkAndSendReminders error:', error.message);
      }
    } finally {
      this.isRunningReminders = false;
    }
  }

  async syncUpcomingEvents(userPhone) {
    try {
      const { google } = require('googleapis');
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return;

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const now = new Date();
      const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const events = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: next24h.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });

      // Get user's default reminder minutes
      const settings = await this.getUserSettings(userPhone);
      const reminderMinutes = settings?.default_reminder_minutes || 15;

      for (const event of (events.data.items || [])) {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const reminderTime = new Date(eventStart.getTime() - reminderMinutes * 60 * 1000);

        if (reminderTime <= now) continue; // Already past reminder time

        // Check if reminder already exists for this event
        const existing = await query(
          `SELECT 1 FROM calendar_reminders WHERE user_phone = $1 AND google_event_id = $2 AND status = 'pending'`,
          [userPhone, event.id]
        );

        if (existing.rows.length === 0) {
          await query(`
            INSERT INTO calendar_reminders (user_phone, google_event_id, event_title, event_start, reminder_time, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
          `, [userPhone, event.id, event.summary || 'Meeting', eventStart.toISOString(), reminderTime.toISOString()]);
        }
      }
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        logger.warn(`Calendar sync failed for ${userPhone}:`, error.message);
      }
    }
  }

  // Sync Outlook calendar events for a user
  async syncOutlookEvents(userPhone) {
    try {
      const outlookCalendarService = require('../services/outlook-calendar.service');
      const microsoftAuthService = require('../services/microsoft-auth.service');
      const tokens = await microsoftAuthService.getTokens(userPhone);
      if (!tokens) return;

      const events = await outlookCalendarService.getUpcomingEvents(userPhone, 24);
      if (!events || events.length === 0) return;

      const settings = await this.getUserSettings(userPhone);
      const reminderMinutes = settings?.default_reminder_minutes || 15;
      const now = new Date();

      for (const event of events) {
        const eventStart = new Date(event.start?.dateTime || event.start);
        const reminderTime = new Date(eventStart.getTime() - reminderMinutes * 60 * 1000);
        if (reminderTime <= now) continue;

        const eventId = event.id || `outlook:${eventStart.getTime()}`;
        const existing = await query(
          `SELECT 1 FROM calendar_reminders WHERE user_phone = $1 AND google_event_id = $2 AND status = 'pending'`,
          [userPhone, eventId]
        );

        if (existing.rows.length === 0) {
          await query(`
            INSERT INTO calendar_reminders (user_phone, google_event_id, event_title, event_start, reminder_time, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
          `, [userPhone, eventId, event.summary || event.subject || 'Meeting', eventStart.toISOString(), reminderTime.toISOString()]);
        }
      }
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        logger.warn(`Outlook sync failed for ${userPhone}:`, error.message);
      }
    }
  }

  // Sync Apple calendar events for a user
  async syncAppleEvents(userPhone) {
    try {
      const appleCalendarService = require('../services/apple-calendar.service');
      const connected = await appleCalendarService.isConnected(userPhone);
      if (!connected) return;

      const events = await appleCalendarService.getUpcomingEvents(userPhone, 24);
      if (!events || events.length === 0) return;

      const settings = await this.getUserSettings(userPhone);
      const reminderMinutes = settings?.default_reminder_minutes || 15;
      const now = new Date();

      for (const event of events) {
        const eventStart = new Date(event.start?.dateTime || event.start);
        const reminderTime = new Date(eventStart.getTime() - reminderMinutes * 60 * 1000);
        if (reminderTime <= now) continue;

        const eventId = event.id || `apple:${eventStart.getTime()}`;
        const existing = await query(
          `SELECT 1 FROM calendar_reminders WHERE user_phone = $1 AND google_event_id = $2 AND status = 'pending'`,
          [userPhone, eventId]
        );

        if (existing.rows.length === 0) {
          await query(`
            INSERT INTO calendar_reminders (user_phone, google_event_id, event_title, event_start, reminder_time, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
          `, [userPhone, eventId, event.summary || 'Meeting', eventStart.toISOString(), reminderTime.toISOString()]);
        }
      }
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        logger.warn(`Apple sync failed for ${userPhone}:`, error.message);
      }
    }
  }

  async runSyncForAllUsers() {
    if (this.isRunningSync) return;
    this.isRunningSync = true;
    try {
      await this.ensureSettingsTable();

      // Paginate — sync in batches of 50 to avoid overwhelming APIs
      let offset = 0;
      const batchSize = 50;
      while (true) {
        const result = await query(
          `SELECT user_phone FROM calendar_sync_settings WHERE sync_enabled = true AND remind_all_meetings = true ORDER BY user_phone LIMIT $1 OFFSET $2`,
          [batchSize, offset]
        );

        if (result.rows.length === 0) break;

        for (const row of result.rows) {
          // Apr 29 2026: parallelise the three provider syncs per user.
          // Each one hits a different external API (Google / Microsoft /
          // Apple) so they don't share rate limits, and serialising them
          // tripled the wall time per user. allSettled means a failure in
          // one provider doesn't block the other two.
          const results = await Promise.allSettled([
            this.syncUpcomingEvents(row.user_phone),
            this.syncOutlookEvents(row.user_phone),
            this.syncAppleEvents(row.user_phone)
          ]);
          for (const r of results) {
            if (r.status === 'rejected') {
              logger.warn(`[CalendarReminder] sync failed for ${row.user_phone}: ${r.reason?.message || r.reason}`);
            }
          }
        }

        offset += batchSize;
        if (result.rows.length < batchSize) break;
      }
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        logger.error('runSyncForAllUsers error:', error.message);
      }
    } finally {
      this.isRunningSync = false;
    }
  }

  async getUserSettings(userPhone) {
    try {
      await this.ensureSettingsTable();
      const result = await query(
        `SELECT * FROM calendar_sync_settings WHERE user_phone = $1`,
        [userPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  async enableRemindAll(userPhone) {
    await this.ensureSettingsTable();
    await query(`
      INSERT INTO calendar_sync_settings (user_phone, sync_enabled, remind_all_meetings)
      VALUES ($1, true, true)
      ON CONFLICT (user_phone) DO UPDATE SET
        sync_enabled = true, remind_all_meetings = true, updated_at = NOW()
    `, [userPhone]);

    // Do an immediate sync
    await this.syncUpcomingEvents(userPhone);

    return true;
  }

  async disableRemindAll(userPhone) {
    await this.ensureSettingsTable();
    await query(`
      INSERT INTO calendar_sync_settings (user_phone, sync_enabled, remind_all_meetings)
      VALUES ($1, false, false)
      ON CONFLICT (user_phone) DO UPDATE SET
        sync_enabled = false, remind_all_meetings = false, updated_at = NOW()
    `, [userPhone]);
    return true;
  }
}

module.exports = new CalendarReminderJob();
