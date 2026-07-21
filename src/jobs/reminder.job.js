const cron = require('node-cron');
const { query } = require('../config/database');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const reminderService = require('../services/reminder.service');
const timezoneService = require('../services/timezone.service');
const memoryService = require('../services/memory.service');
const contactService = require('../services/contact.service');
const whatsappAdapter = require('../adapters/whatsapp.adapter');
const TEMPLATES = require('../config/whatsapp-templates');
const logger = require('../utils/logger');

// Reminder delivery picks one of FOUR Meta templates based on:
//   1. WHO receives it (self vs other)
//   2. Whether it's a one-off or recurring schedule
//   3. Whether it's a scheduled-message (Ari just relays the user's text)
//
//   SELF + one-off                -> personal_reminder        (1 param: text)
//   SELF + recurring              -> reminder_2 (RECURRING)   (1 param: text)
//   OTHER + reminder              -> appointment_reminder     (2 params: sender, text)
//   OTHER + scheduled_message     -> appointment_reminder     (2 params: sender, text)
//                                    (SCHEDULED_MESSAGE alias — same template, copy
//                                    has "Reminder:" prefix; per the constants-file
//                                    comment this is an accepted compromise.)
function pickReminderTemplate(isForOther, isRecurring, isScheduledMessage) {
  if (isForOther) {
    return isScheduledMessage ? TEMPLATES.SCHEDULED_MESSAGE : TEMPLATES.APPOINTMENT_REMINDER;
  }
  return isRecurring ? TEMPLATES.RECURRING_REMINDER : TEMPLATES.PERSONAL_REMINDER;
}
function buildReminderParams(isForOther, senderName, message) {
  return isForOther ? [senderName, message] : [message];
}

class ReminderJob {

  constructor() {
    this.dayMap = { 'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6 };
    this.schemaReady = false;
    this.isRunning = false;
  }

  async start() {
    // Run schema check once at startup
    try {
      await reminderService.ensureRemindersSchema();
      this.schemaReady = true;
      logger.info('Reminders schema verified');
    } catch (e) {
      logger.error('Failed to verify reminders schema:', e.message);
    }

    // Try to use pg-boss first (durable, multi-instance safe, survives restarts).
    // Falls back to node-cron if pg-boss isn't ready or feature flag is off.
    const usePgBoss = process.env.USE_PG_BOSS === 'true';
    let pgBossStarted = false;

    if (usePgBoss) {
      try {
        const { getBoss, isReady } = require('../config/jobs');
        const { QUEUES, getWorkOptions } = require('./queue-definitions');

        if (isReady()) {
          const boss = getBoss();
          const queueName = 'reminder-poll';

          // pg-boss v10+ requires createQueue before work/schedule.
          if (typeof boss.createQueue === 'function') {
            try { await boss.createQueue(queueName); }
            catch (e) { if (!/already exists/i.test(e.message)) throw e; }
          }

          // Register worker that does the polling work.
          await boss.work(queueName, getWorkOptions(QUEUES.REMINDER_SEND), async () => {
            await this.checkAndSendReminders();
          });

          // Schedule the polling job every 30 seconds.
          await boss.schedule(queueName, '*/30 * * * * *');

          logger.info('Reminder job started via pg-boss (durable, multi-instance safe)');
          pgBossStarted = true;
        }
      } catch (e) {
        logger.warn(`pg-boss reminder job failed to start, falling back to node-cron: ${e.message}`);
      }
    }

    if (!pgBossStarted) {
      // Legacy node-cron path.
      cron.schedule('*/30 * * * * *', async () => {
        try {
          await this.checkAndSendReminders();
        } catch (error) {
          logger.error('Reminder job error:', error.message);
        }
      });
      logger.info('Reminder job started via node-cron — checking every 30 seconds');
    }

    setTimeout(() => this.checkAndSendReminders(), 3000);
  }

  async checkAndSendReminders() {
    if (this.isRunning) return; // Prevent overlap within this process
    this.isRunning = true;

    // H7-N fix (Batch F4): cross-process advisory lock so a PM2 reload
    // mid-cycle doesn't double-fire reminders. The in-memory isRunning
    // flag above only protects within one process; the new advisory
    // lock (Postgres pg_try_advisory_lock with a magic number) protects
    // across processes too. If the lock is held by the OLD process
    // still finishing, the NEW one bails — next cron tick will retry.
    const ADVISORY_KEY = 0x5e511a01;  // Stable advisory-lock key for the Ari reminder job.
    let lockClient = null;
    try {
      const { pool } = require('../config/database');
      lockClient = await pool.connect();
      const lr = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_KEY]);
      if (!lr.rows[0]?.got) {
        logger.debug('[Reminder] Advisory lock busy — another process is mid-cycle, skipping');
        try { lockClient.release(); } catch (_) {}
        this.isRunning = false;
        return;
      }
    } catch (e) {
      // Pool exhausted or DB down. Fall through to local-only protection.
      logger.warn(`[Reminder] Could not acquire advisory lock: ${e.message}`);
      if (lockClient) { try { lockClient.release(); } catch (_) {} lockClient = null; }
    }

    try {
      if (!this.schemaReady) {
        await reminderService.ensureRemindersSchema();
        this.schemaReady = true;
      }

      const now = new Date();
      const nowISO = now.toISOString();

      // Apr 29 2026: demoted from .info to .debug — this fired every 30s
      // even when nothing was due, drowning out signal in production logs.
      logger.debug(`Checking reminders at ${nowISO}`);

      // Fetch only due reminders — filter in SQL to avoid picking up future ones
      // Also skip reminders sent in the last 55 seconds to prevent blast loops
      const result = await query(
        `SELECT * FROM reminders
         WHERE status = 'pending'
           AND COALESCE(next_occurrence, reminder_time) <= NOW()
           AND (last_sent IS NULL OR last_sent < NOW() - INTERVAL '55 seconds')
         ORDER BY COALESCE(next_occurrence, reminder_time) ASC
         LIMIT 50`
      );

      const due = result.rows;

      if (due.length === 0) {
        return;
      }

      logger.info(`>>> Sending ${due.length} reminder(s)`);

      for (const reminder of due) {
        await this.sendReminder(reminder);
      }

    } catch (error) {
      logger.error('Check reminders error:', error.message);
    } finally {
      this.isRunning = false;
      // Release the cross-process advisory lock (matching pg_try_advisory_lock above)
      if (lockClient) {
        try { await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]); } catch (_) { /* swallow */ }
        try { lockClient.release(); } catch (_) {}
      }
    }
  }

  // Check if a phone number has interacted with the bot within the last 24 hours
  // WhatsApp only allows free-form messages within a 24-hour window after the user's last message
  async hasRecentInteraction(phone) {
    try {
      // Check conversation_history for a user message within the last 24 hours
      const result = await query(
        `SELECT 1 FROM conversation_history
         WHERE user_phone = $1 AND role = 'user'
         AND created_at >= NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [phone]
      );
      return result.rows.length > 0;
    } catch (e) {
      logger.warn(`hasRecentInteraction check failed: ${e.message}`);
      // Fall back to checking if they've ever interacted
      return this.hasEverInteracted(phone);
    }
  }

  // Check if a phone number has ever interacted with the bot (fallback)
  async hasEverInteracted(phone) {
    try {
      const result = await query(
        `SELECT 1 FROM user_settings WHERE user_phone = $1 LIMIT 1`,
        [phone]
      );
      if (result.rows.length > 0) return true;

      const memResult = await query(
        `SELECT 1 FROM memories WHERE user_phone = $1 LIMIT 1`,
        [phone]
      );
      if (memResult.rows.length > 0) return true;

      const remResult = await query(
        `SELECT 1 FROM reminders WHERE user_phone = $1 LIMIT 1`,
        [phone]
      );
      return remResult.rows.length > 0;
    } catch (e) {
      logger.warn(`hasEverInteracted check failed: ${e.message}`);
      return false;
    }
  }

  async sendReminder(reminder) {
    try {
      // Atomic claim: mark last_sent NOW to prevent the next cron cycle from re-picking this up.
      // If another cycle already claimed it in the last 55s, skip silently.
      const claimed = await query(
        `UPDATE reminders SET last_sent = NOW()
         WHERE id = $1 AND (last_sent IS NULL OR last_sent < NOW() - INTERVAL '55 seconds')
         RETURNING id`,
        [reminder.id]
      );
      if (claimed.rows.length === 0) {
        logger.info(`Reminder #${reminder.id} already claimed recently, skipping`);
        return;
      }

      // Normalize target_phone: strip leading '+' so it matches DB format (e.g. '917595977796')
      if (reminder.target_phone) {
        reminder.target_phone = reminder.target_phone.replace(/^\+/, '');
      }

      // IMPORTANT: Send to target_phone, not user_phone
      const isForOther = reminder.target_phone && reminder.target_phone !== reminder.user_phone;

      // Resolve preferred notification platform for each recipient
      const rawRecipient = reminder.target_phone || reminder.user_phone;
      let recipient = await accountLinkService.getNotifyUserId(rawRecipient);

      logger.info(`Sending reminder #${reminder.id} to ${recipient}`);

      // Build message
      let message;
      const isScheduledMessage = reminder.message_type === 'scheduled_message';

      if (isScheduledMessage) {
        // Scheduled message: send as direct message without prefix
        if (isForOther) {
          const senderName = await this.resolveSenderName(reminder.user_phone);
          message = `*Message from ${senderName}:*\n\n${reminder.message}`;
        } else {
          message = reminder.message;
        }
      } else if (isForOther) {
        // Resolve sender's name for the message
        const senderName = await this.resolveSenderName(reminder.user_phone);
        message = `*${senderName} sent you a reminder:*\n\n${reminder.message}`;
      } else {
        message = `*Reminder*\n\n${reminder.message}`;
      }

      // For delegated reminders where sender and recipient are in different
      // timezones, append the recipient's local time so they know exactly
      // when the reminder fired in their wall-clock. The body of the message
      // itself is left untouched (it might say "12:58" referring to the
      // sender's time — we don't want to find/replace times in arbitrary text).
      if (isForOther) {
        try {
          const senderTz = await timezoneService.getUserTimezone(reminder.user_phone);
          const recipientTz = await timezoneService.getUserTimezone(reminder.target_phone);
          if (senderTz && recipientTz && senderTz !== recipientTz && reminder.reminder_time) {
            const recipientLocal = new Date(reminder.reminder_time).toLocaleString('en-US', {
              timeZone: recipientTz,
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              timeZoneName: 'short',
            });
            message += `\n\n_Your local time: ${recipientLocal}_`;
          }
        } catch (e) {
          logger.debug(`[reminder.job] Could not append local time footer: ${e.message}`);
        }
      }

      // Add recurring info
      if (reminder.is_recurring && reminder.recurrence_pattern) {
        const timeStr = this.formatTime(reminder.recurrence_time);
        message += `\n\n_${reminder.recurrence_pattern} at ${timeStr}_`;
      }

      // Check if recipient is outside 24h window — if so, use template instead of free-form
      // This applies to ALL recipients (self or other), not just other-person reminders
      const recipientPhone = rawRecipient.replace(/^wa_/, '');
      const isWhatsAppUser = !rawRecipient.startsWith('dc_') && !rawRecipient.startsWith('tg_') && !rawRecipient.startsWith('sl_') && !rawRecipient.startsWith('gc_');
      const hasRecent = isWhatsAppUser ? await this.hasRecentInteraction(recipientPhone) : true;

      if (!hasRecent && isWhatsAppUser) {
        logger.info(`Recipient ${recipientPhone} outside 24h window — using template fallback`);
        try {
          const senderName = isForOther
            ? await this.resolveSenderName(reminder.user_phone)
            : 'Ari';
          const tpl = pickReminderTemplate(isForOther, !!reminder.is_recurring, isScheduledMessage);
          await whatsappAdapter.sendTemplate(
            recipientPhone,
            tpl.name,
            tpl.lang,
            buildReminderParams(isForOther, senderName, reminder.message)
          );
          logger.info(`Reminder #${reminder.id} sent via template "${tpl.name}" to ${recipientPhone}`);

          // Mark as sent
          if (reminder.is_recurring) {
            await this.scheduleNextOccurrence(reminder);
          } else {
            await query(`UPDATE reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`, [reminder.id]);
          }

          // Notify creator if sent to someone else
          if (isForOther) {
            const recipientName = await this.resolveRecipientName(reminder.user_phone, reminder.target_phone);
            const maskedPhone = contactService.maskPhone(reminder.target_phone);
            try {
              await messagingService.send(
                reminder.user_phone,
                `Reminder sent to ${recipientName} (${maskedPhone}):\n"${reminder.message}"`
              );
            } catch (e) {
              logger.warn(`Could not notify creator: ${e.message}`);
            }
          }
          return;
        } catch (templateError) {
          logger.error(`Template fallback failed for #${reminder.id}: ${templateError.message}`);
          // If template also fails, fall through to try free-form as last resort
        }
      }

      // Send free-form message to recipient (within 24h window or non-WhatsApp platform)
      await messagingService.send(recipient, message);
      logger.info(`Reminder #${reminder.id} sent to ${recipient}`);

      // Notify creator if sent to someone else
      if (isForOther) {
        const recipientName = await this.resolveRecipientName(reminder.user_phone, recipient);
        const maskedPhone = contactService.maskPhone(recipient);
        try {
          await messagingService.send(
            reminder.user_phone,
            `Reminder sent to ${recipientName} (${maskedPhone}):\n"${reminder.message}"`
          );
          logger.info(`Notified creator ${reminder.user_phone}`);
        } catch (e) {
          logger.warn(`Could not notify creator: ${e.message}`);
        }
      }

      // Update status
      if (reminder.is_recurring) {
        await this.scheduleNextOccurrence(reminder);
      } else {
        await query(`UPDATE reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`, [reminder.id]);
      }

    } catch (error) {
      logger.error(`Failed to send #${reminder.id}:`, error.message);
      const errorCode = error.response?.data?.error?.code;
      const errorMsg = error.response?.data?.error?.message || error.message;
      logger.error(`Reminder #${reminder.id} error detail — code: ${errorCode}, message: ${errorMsg}`);

      // If free-form failed, try template as last resort (likely 24h window expired)
      const fallbackPhone = (reminder.target_phone || reminder.user_phone).replace(/^wa_/, '');
      const isWA = !fallbackPhone.startsWith('dc_') && !fallbackPhone.startsWith('tg_') && !fallbackPhone.startsWith('sl_');
      if (isWA) {
        try {
          logger.info(`Attempting template fallback for failed reminder #${reminder.id} to ${fallbackPhone}`);
          const isForOtherFallback = reminder.target_phone && reminder.target_phone !== reminder.user_phone;
          const senderName = isForOtherFallback
            ? await this.resolveSenderName(reminder.user_phone)
            : 'Ari';
          const isScheduledMsgFallback = reminder.message_type === 'scheduled_message';
          const tpl = pickReminderTemplate(isForOtherFallback, !!reminder.is_recurring, isScheduledMsgFallback);
          await whatsappAdapter.sendTemplate(
            fallbackPhone,
            tpl.name,
            tpl.lang,
            buildReminderParams(isForOtherFallback, senderName, reminder.message)
          );
          logger.info(`Reminder #${reminder.id} sent via template "${tpl.name}" fallback to ${fallbackPhone}`);

          if (reminder.is_recurring) {
            await this.scheduleNextOccurrence(reminder);
          } else {
            await query(`UPDATE reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`, [reminder.id]);
          }
          return;
        } catch (templateErr) {
          logger.error(`Template fallback also failed for #${reminder.id}: ${templateErr.message}`);
          const tplCode = templateErr.response?.data?.error?.code;
          logger.error(`Template error code: ${tplCode}`);
        }
      }

      // Track retry count to prevent infinite retry loops
      const retryCount = (reminder.retry_count || 0) + 1;
      const maxRetries = 3;
      const isRecurring = !!(reminder.is_recurring && reminder.recurrence_pattern);

      // Apr 29 2026 — RECURRING-AWARE FAILURE HANDLING
      //
      // Previously, ANY of the three failure paths below blindly marked
      // status='failed', which permanently killed recurring series after
      // a single bad occurrence. The cron filter `WHERE status='pending'`
      // would then exclude the reminder forever.
      //
      // For a recurring reminder, "this one delivery failed" should mean
      // "skip this occurrence and try the next one tomorrow", NOT "kill
      // the entire series." We now route recurring reminders through
      // scheduleNextOccurrence so they survive transient delivery
      // failures, Meta hiccups, and brief bot outages.
      const skipToNextOccurrence = async (reasonLog) => {
        logger.warn(`Recurring reminder #${reminder.id} ${reasonLog} — advancing to next occurrence`);
        try {
          await query(`UPDATE reminders SET retry_count = 0 WHERE id = $1`, [reminder.id]);
          await this.scheduleNextOccurrence(reminder);
        } catch (advanceErr) {
          logger.error(`Failed to advance recurring #${reminder.id} after delivery failure: ${advanceErr.message}`);
        }
      };

      if (reminder.target_phone && reminder.target_phone !== reminder.user_phone) {
        // If sending to other fails, notify creator
        const recipientName = await this.resolveRecipientName(reminder.user_phone, reminder.target_phone);
        const maskedPhone = contactService.maskPhone(reminder.target_phone);
        try {
          // User-facing message avoids mentioning templates / Meta / delivery
          // mechanism — per product decision, users only see that delivery
          // didn't work, not WHY the underlying WhatsApp plumbing failed.
          await messagingService.send(
            reminder.user_phone,
            `Could not deliver reminder to ${recipientName} (${maskedPhone}). Please try again later.`
          );
        } catch (e) {
          logger.warn(`Could not notify creator about failed reminder: ${e.message}`);
        }
        if (isRecurring) {
          await skipToNextOccurrence('delivery to recipient failed');
        } else {
          await query(`UPDATE reminders SET status = 'failed' WHERE id = $1`, [reminder.id]);
        }
      } else if (retryCount >= maxRetries) {
        // Max retries exceeded
        if (isRecurring) {
          await skipToNextOccurrence(`exhausted ${maxRetries} retries`);
        } else {
          logger.warn(`Reminder #${reminder.id} failed after ${maxRetries} retries, marking as failed`);
          await query(`UPDATE reminders SET status = 'failed' WHERE id = $1`, [reminder.id]);
        }
      } else {
        // Increment retry count; also fail if overdue by more than 15 minutes
        const reminderTime = new Date(reminder.next_occurrence || reminder.reminder_time);
        if ((Date.now() - reminderTime.getTime()) > 15 * 60 * 1000) {
          if (isRecurring) {
            await skipToNextOccurrence('overdue by >15 minutes');
          } else {
            logger.warn(`Reminder #${reminder.id} overdue by >15min, marking as failed`);
            await query(`UPDATE reminders SET status = 'failed' WHERE id = $1`, [reminder.id]);
          }
        } else {
          await query(`UPDATE reminders SET retry_count = $2 WHERE id = $1`, [reminder.id, retryCount]);
        }
      }
    }
  }

  // Resolve the sender's display name from their memories (e.g., "Rahul")
  async resolveSenderName(senderPhone) {
    try {
      // Check memory trunk for the sender's own name
      const trunk = await memoryService.getMemoryTrunk(senderPhone);
      if (trunk && trunk.personal) {
        const nameEntry = trunk.personal.find(m => m.key === 'name');
        if (nameEntry) return nameEntry.value;
      }
      // Fallback to phone
      return `+${senderPhone}`;
    } catch (e) {
      return `+${senderPhone}`;
    }
  }

  // Resolve the recipient's display name from the sender's contacts
  async resolveRecipientName(senderPhone, recipientPhone) {
    try {
      const contacts = await contactService.findByPhone(senderPhone, recipientPhone);
      if (contacts.length > 0) return contacts[0].name;
      return contactService.maskPhone(recipientPhone);
    } catch (e) {
      return contactService.maskPhone(recipientPhone);
    }
  }

  async scheduleNextOccurrence(reminder) {
    try {
      if (!reminder.recurrence_time) {
        await query(`UPDATE reminders SET status = 'completed' WHERE id = $1`, [reminder.id]);
        return;
      }

      // Use user's timezone for correct scheduling
      const userTimezone = await timezoneService.getUserTimezone(reminder.user_phone);
      const [hours, minutes] = reminder.recurrence_time.split(':').map(Number);

      const nowLocal = reminderService.getZonedParts(new Date(), userTimezone);
      let targetDate = reminderService.addDaysInZone(nowLocal, 1, userTimezone);

      let next;
      // Find next valid day for pattern
      for (let i = 0; i < 14; i++) {
        const candidateUtc = reminderService.zonedWallTimeToUtcDate(
          { ...targetDate, hour: hours, minute: minutes, second: 0 }, userTimezone
        );
        const day = candidateUtc.getDay();
        let valid = true;

        switch (reminder.recurrence_pattern) {
          case 'weekdays': valid = day >= 1 && day <= 5; break;
          case 'weekends': valid = day === 0 || day === 6; break;
          case 'weekly':
            if (reminder.recurrence_days) {
              const days = reminder.recurrence_days.split(',');
              valid = days.some(d => this.dayMap[d.trim()] === day);
            }
            break;
        }

        if (reminder.except_days) {
          const except = reminder.except_days.split(',');
          if (except.some(d => this.dayMap[d.trim()] === day)) valid = false;
        }

        if (valid) {
          next = candidateUtc;
          break;
        }
        targetDate = reminderService.addDaysInZone(
          { ...targetDate, hour: 12, minute: 0, second: 0 }, 1, userTimezone
        );
      }

      if (!next) {
        // Fallback: just schedule for tomorrow
        next = reminderService.zonedWallTimeToUtcDate(
          { ...targetDate, hour: hours, minute: minutes, second: 0 }, userTimezone
        );
      }

      // Fix: pass the same timestamp twice as separate params. Postgres can't deduce a
      // single type for one `$1` placeholder used across columns with different types
      // (`next_occurrence` is TIMESTAMP, `reminder_time` is TIMESTAMPTZ) — it throws
      // "inconsistent types deduced for parameter $1". Using $1 and $2 lets each
      // column resolve its own cast.
      await query(
        `UPDATE reminders SET next_occurrence = $1, reminder_time = $2, last_sent = NOW() WHERE id = $3`,
        [next.toISOString(), next.toISOString(), reminder.id]
      );

      logger.info(`Next occurrence for #${reminder.id}: ${next.toISOString()}`);

    } catch (error) {
      logger.error(`Schedule next error for #${reminder.id}:`, error.message);
      // Don't mark as permanently failed — use a safe fallback (tomorrow same time)
      try {
        const fallbackNext = new Date(Date.now() + 24 * 60 * 60 * 1000);
        if (reminder.recurrence_time) {
          const [h, m] = reminder.recurrence_time.split(':').map(Number);
          fallbackNext.setUTCHours(h - 5, m - 30); // Rough IST offset fallback
        }
        // Same parameter-type-inference fix as the main update above.
        await query(
          `UPDATE reminders SET next_occurrence = $1, reminder_time = $2, last_sent = NOW(), retry_count = 0 WHERE id = $3`,
          [fallbackNext.toISOString(), fallbackNext.toISOString(), reminder.id]
        );
        logger.warn(`Fallback: scheduled recurring reminder #${reminder.id} for ${fallbackNext.toISOString()}`);
      } catch (dbErr) {
        logger.error(`Could not reschedule reminder #${reminder.id}:`, dbErr.message);
        // Apr 29 2026 — Do NOT mark recurring reminders as 'failed' here.
        // A transient DB error during scheduling should not kill an entire
        // recurring series forever. Leave status='pending' so the next cron
        // tick re-attempts to advance next_occurrence. The reminder may
        // re-fire once at the same time (acceptable) but the series stays
        // alive. ONLY mark non-recurring reminders as failed as last resort.
        if (reminder.is_recurring && reminder.recurrence_pattern) {
          logger.warn(`Recurring reminder #${reminder.id} schedule-next failed twice — leaving status='pending', retry_count=0 for next cron tick`);
          await query(`UPDATE reminders SET retry_count = 0 WHERE id = $1`, [reminder.id]).catch(() => {});
        } else {
          await query(`UPDATE reminders SET status = 'failed' WHERE id = $1`, [reminder.id]).catch(() => {});
        }
      }
    }
  }

  formatTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const period = h >= 12 ? 'pm' : 'am';
    const hour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${hour}:${m.toString().padStart(2, '0')} ${period}`;
  }
}

module.exports = new ReminderJob();
