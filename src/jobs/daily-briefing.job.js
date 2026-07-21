/**
 * Daily Briefing Job — auto-sends the morning briefing at 8 AM in the user's
 * local timezone (configurable per-user via user_settings.briefing_hour).
 *
 * Flow per triggered user:
 *   1. Send message A — tasks / assigned items / meetings / reminders (no news).
 *   2. Wait ~3 seconds (so WhatsApp renders them as two chronological bubbles).
 *   3. Send message B — top 10 world news with one-liners + deep-dive hint.
 *   4. Record briefing_last_sent_date (in user's local tz) for idempotency.
 *
 * Scheduling:
 *   - Cron fires every 15 minutes.
 *   - For each user with briefing_enabled=true, compute `localHour` and
 *     `localDate` via their stored timezone.
 *   - Send if: localHour == briefing_hour  AND  briefing_last_sent_date != localDate.
 *
 * This avoids a global 8am cron (would wake at 2:30am IST for an EST user) and
 * the 15-min granularity is a comfortable balance between precision and DB load.
 */

const cron = require('node-cron');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const briefingService = require('../services/briefing.service');
const messagingService = require('../services/messaging.service');

const INTER_MESSAGE_DELAY_MS = 3000;

class DailyBriefingJob {
  constructor() {
    this.isRunning = false;
  }

  async start() {
    // One-time: ensure the briefing columns exist on user_settings.
    await this.ensureSchema();

    // Every 15 minutes (at :00, :15, :30, :45).
    cron.schedule('*/15 * * * *', async () => {
      try {
        await this.run();
      } catch (e) {
        logger.error('Daily briefing job error:', e.message);
      }
    });

    logger.info('Daily briefing job started — polling every 15min, sends at local 8am');
  }

  /**
   * Idempotent schema upgrade. Adds briefing columns if missing.
   * v2 additions (streak, pause, length pref, hero-ref cache):
   *   briefing_streak_count        INT       — consecutive days user consumed brief
   *   briefing_streak_best         INT       — personal best (loss-aversion display)
   *   briefing_last_streak_date    DATE      — last day streak was incremented
   *   briefing_streak_freezes      INT       — free saves remaining this month
   *   briefing_streak_freeze_reset_month INT — month tag (1-12) when freezes last reset
   *   briefing_length_preference   TEXT      — short / standard / detailed
   *   briefing_paused_until        DATE      — honors `skip` reply for 1 day
   *   briefing_last_hero_ref       JSONB     — {type, id, title} so `done` knows target
   *   briefing_last_sent_count     INT       — total briefings sent lifetime
   */
  async ensureSchema() {
    try {
      await query(`
        ALTER TABLE user_settings
          ADD COLUMN IF NOT EXISTS briefing_enabled BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS briefing_hour INT DEFAULT 8,
          ADD COLUMN IF NOT EXISTS briefing_last_sent_date DATE,
          ADD COLUMN IF NOT EXISTS briefing_streak_count INT DEFAULT 0,
          ADD COLUMN IF NOT EXISTS briefing_streak_best INT DEFAULT 0,
          ADD COLUMN IF NOT EXISTS briefing_last_streak_date DATE,
          ADD COLUMN IF NOT EXISTS briefing_streak_freezes INT DEFAULT 1,
          ADD COLUMN IF NOT EXISTS briefing_streak_freeze_reset_month INT,
          ADD COLUMN IF NOT EXISTS briefing_length_preference TEXT DEFAULT 'standard',
          ADD COLUMN IF NOT EXISTS briefing_paused_until DATE,
          ADD COLUMN IF NOT EXISTS briefing_last_hero_ref JSONB,
          ADD COLUMN IF NOT EXISTS briefing_last_sent_count INT DEFAULT 0
      `);
      logger.info('Daily briefing: user_settings schema verified (v2 columns)');
    } catch (e) {
      logger.warn(`Daily briefing schema ensure skipped: ${e.message}`);
    }

    // One-time idempotent cleanup: the legacy `delegated_tasks` table is no longer
    // populated by any active code path. Archive stale >7d-old 'pending' rows so
    // they don't keep surfacing anywhere that still reads them. Safe on every boot.
    try {
      const res = await query(`
        UPDATE delegated_tasks
        SET status = 'archived'
        WHERE status = 'pending'
          AND created_at < NOW() - INTERVAL '7 days'
      `);
      if (res?.rowCount > 0) {
        logger.info(`Daily briefing: archived ${res.rowCount} stale legacy delegated_tasks rows`);
      }
    } catch (_) {
      // Table may not exist on fresh installs — safe to ignore
    }
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      // Pull everyone with briefing enabled; compute send-check per user.
      // We deliberately do this in JS rather than SQL because user timezones
      // are IANA strings and Postgres wouldn't offer much over a JS date pass.
      // Cast DATE columns to YYYY-MM-DD text in SQL — pg parses DATE as
      // local-midnight, so .toISOString() shifts on positive-offset servers.
      // TO_CHAR gives us an opaque date string that matches what we stored.
      const result = await query(
        `SELECT user_phone, timezone, briefing_hour,
                TO_CHAR(briefing_last_sent_date, 'YYYY-MM-DD') AS briefing_last_sent_date,
                TO_CHAR(briefing_paused_until, 'YYYY-MM-DD') AS briefing_paused_until
         FROM user_settings
         WHERE briefing_enabled = TRUE`
      );

      if (result.rows.length === 0) return;

      const now = new Date();
      // Apr 29 2026: parallelise in batches of 10. The serial loop took
      // ~30-60s for ~50 users because each user's brief makes 2-3 LLM
      // calls + a WhatsApp send. allSettled batches of 10 cap concurrent
      // LLM load (so we don't stampede provider rate limits) while still
      // cutting wall time roughly 10x. Each user already has its own
      // try/catch in maybeSendForUser, but we re-catch defensively.
      const BATCH_SIZE = parseInt(process.env.DAILY_BRIEFING_BATCH || '10', 10);
      for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
        const batch = result.rows.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
          batch.map(row => this.maybeSendForUser(row, now))
        );
        for (let j = 0; j < settled.length; j++) {
          if (settled[j].status === 'rejected') {
            const reason = settled[j].reason;
            logger.warn(`Daily briefing failed for ${batch[j].user_phone}: ${reason?.message || reason}`);
          }
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * For one user, check local time vs their configured hour and send if due.
   * @param {{user_phone, timezone, briefing_hour, briefing_last_sent_date}} row
   * @param {Date} now
   */
  async maybeSendForUser(row, now) {
    const tz = row.timezone || 'Asia/Kolkata';
    const sendHour = Number.isFinite(Number(row.briefing_hour)) ? Number(row.briefing_hour) : 8;

    // Compute local hour + date in user's timezone.
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const localHour = localNow.getHours();
    const localDateStr = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;

    // Not the hour yet? skip.
    if (localHour !== sendHour) return;

    // Already sent today (in user's local tz)? skip.
    // row.briefing_last_sent_date is already a YYYY-MM-DD string (via TO_CHAR in the query).
    if (row.briefing_last_sent_date && row.briefing_last_sent_date === localDateStr) return;

    // Honors `skip` reply — user paused briefings for a day. Once the pause
    // date is <= today, the pause is effectively over and we ignore it.
    if (row.briefing_paused_until && row.briefing_paused_until >= localDateStr) {
      logger.debug({ userPhone: row.user_phone, pausedUntil: row.briefing_paused_until, localDateStr }, 'Daily briefing paused by user');
      return;
    }

    // Focus-mode gate: if the user is in an active focus session, defer the
    // briefing. We mark today as "sent" so we don't pile up retries — the
    // user will see tomorrow's briefing fresh, and they can still pull the
    // briefing manually by saying "give me the briefing". Reminders, tasks,
    // and meeting alerts are NOT gated here — they're time-critical.
    try {
      const focusService = require('../services/focus.service');
      if (await focusService.isActive(row.user_phone)) {
        logger.info({ userPhone: row.user_phone }, 'Daily briefing deferred — user in focus mode');
        await query(
          `UPDATE user_settings SET briefing_last_sent_date = $2, updated_at = NOW() WHERE user_phone = $1`,
          [row.user_phone, localDateStr]
        ).catch(() => {});
        return;
      }
    } catch (e) {
      logger.warn(`Focus check failed for ${row.user_phone}, sending briefing anyway: ${e.message}`);
    }

    logger.info({ userPhone: row.user_phone, tz, localHour, localDateStr }, 'Sending daily briefing');

    // DURABLE PATH — when Inngest is enabled, dispatch a per-user event
    // and return. If the cron worker dies mid-loop, only the current user
    // needs retry — all other users proceed via their own independent
    // Inngest runs. Failure isolation is per-user, not per-cron-batch.
    try {
      const inngestService = require('../services/inngest.service');
      if (inngestService.isEnabled()) {
        const dispatched = await inngestService.send('briefing/daily.requested', {
          userPhone: row.user_phone,
          localDateStr
        });
        // H5-N fix (Batch F4): until May 19 2026 a `dispatched=null`
        // (Inngest down or disabled mid-batch) was treated as a no-op,
        // so briefings vanished silently. Now we log + fall through to
        // the inline send path below.
        if (!dispatched) {
          logger.warn({ userPhone: row.user_phone, localDateStr }, '[Briefing] Inngest dispatch returned null — falling back to inline send');
        }
        if (dispatched) {
          // Mark sent optimistically to prevent duplicate dispatch next poll.
          // If the Inngest function fails after all retries, the user will
          // see their morning briefing missing — that's the acceptable worst
          // case, strictly better than today's "half your users miss it" mode.
          await query(
            `UPDATE user_settings SET briefing_last_sent_date = $2, updated_at = NOW() WHERE user_phone = $1`,
            [row.user_phone, localDateStr]
          ).catch(() => {});
          return;
        }
      }
    } catch (e) {
      logger.warn(`Daily briefing Inngest dispatch failed for ${row.user_phone}, falling back to inline: ${e.message}`);
    }

    // Fallback — synchronous send (crash-unsafe if cron worker dies mid-loop)
    const tasksMsg = await briefingService.generateDailyBriefing(row.user_phone, { includeNews: false });
    if (tasksMsg) {
      await messagingService.send(row.user_phone, tasksMsg);
    }

    await new Promise(r => setTimeout(r, INTER_MESSAGE_DELAY_MS));

    const newsMsg = await briefingService.generateNewsBriefing(row.user_phone);
    if (newsMsg) {
      await messagingService.send(row.user_phone, newsMsg);
    }

    await query(
      `UPDATE user_settings
       SET briefing_last_sent_date = $2,
           updated_at = NOW()
       WHERE user_phone = $1`,
      [row.user_phone, localDateStr]
    );
  }
}

module.exports = new DailyBriefingJob();
