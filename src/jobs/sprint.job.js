const cron = require('node-cron');
const { query } = require('../config/database');
const sprintService = require('../services/sprint.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class SprintJob {

  constructor() {
    this.isRunningUpdate = false;
    this.isRunningEndWarning = false;
  }

  start() {
    // Poll every 15 minutes and decide per-admin based on their local time
    // (same model as daily-briefing.job). Until May 19 2026 these crons were
    // hardcoded to UTC 9am / UTC 5pm, which meant US users got the daily
    // update at midnight or 4am local. Now each admin gets the update at
    // their actual local 9am weekdays / 5pm.
    cron.schedule('*/15 * * * *', async () => {
      try {
        await this.sendDailyUpdates();
        await this.checkSprintEndWarnings();
      } catch (error) {
        logger.error('Sprint job error:', error.message);
      }
    });

    logger.info('Sprint job started - per-user-tz dispatch every 15 min (9am weekdays / 5pm end warnings)');
  }

  // Compute the admin's current local hour/dow/date. Mirrors the helper used
  // by daily-briefing.job. Falls back to Asia/Kolkata if no tz on file.
  async _localClockFor(adminPhone) {
    let tz = 'Asia/Kolkata';
    try {
      const r = await query(
        `SELECT timezone FROM user_settings WHERE user_phone = $1 LIMIT 1`,
        [adminPhone]
      );
      if (r.rows[0]?.timezone) tz = r.rows[0].timezone;
    } catch { /* fall back to default */ }
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    return {
      tz,
      hour: local.getHours(),
      // 0=Sunday, 1=Monday, ..., 6=Saturday — matches cron day-of-week
      dow: local.getDay(),
      dateStr: `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`,
    };
  }

  async sendDailyUpdates() {
    if (this.isRunningUpdate) return;
    this.isRunningUpdate = true;
    try {
      // Get all active sprint admins
      const result = await query(
        `SELECT DISTINCT team_admin_phone FROM sprints WHERE status = 'active'`
      );

      if (result.rows.length === 0) return;

      for (const row of result.rows) {
        try {
          // Per-admin local-time gate. Only fire on Mon-Fri at local 9am.
          const clock = await this._localClockFor(row.team_admin_phone);
          if (clock.hour !== 9) continue;
          if (clock.dow === 0 || clock.dow === 6) continue; // skip weekend
          // Per-day idempotency — track last sent date per admin.
          if (!this._lastDailyUpdateSent) this._lastDailyUpdateSent = new Map();
          const last = this._lastDailyUpdateSent.get(row.team_admin_phone);
          if (last === clock.dateStr) continue;
          this._lastDailyUpdateSent.set(row.team_admin_phone, clock.dateStr);

          const status = await sprintService.getSprintStatus(row.team_admin_phone);

          if (!status) continue;

          const sprintName = status.sprint.name || 'Unnamed';
          const { progressPercent, completedPoints, totalPoints, burndown } = status.stats;
          const startDate = new Date(status.sprint.start_date);
          const endDate = status.sprint.end_date ? new Date(status.sprint.end_date) : null;
          const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - Date.now()) / 86400000)) : '?';

          const message = `Sprint Update: ${sprintName}\n` +
            `Progress: ${progressPercent}% (${completedPoints}/${totalPoints} pts)\n` +
            `Remaining: ${burndown} pts\n` +
            `${daysLeft} days left`;

          const progress = `${progressPercent}% (${completedPoints}/${totalPoints} pts)`;
          await sendWithTemplateFallback(row.team_admin_phone, message, TEMPLATES.SPRINT_UPDATE, [sprintName, progress, String(daysLeft)]);

          logger.info(`Sprint update sent to ${row.team_admin_phone}`);
        } catch (error) {
          logger.error(`Failed to send sprint update to ${row.team_admin_phone}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('sendDailyUpdates error:', error.message);
    } finally {
      this.isRunningUpdate = false;
    }
  }

  async checkSprintEndWarnings() {
    if (this.isRunningEndWarning) return;
    this.isRunningEndWarning = true;
    try {
      // Find sprints ending tomorrow
      const result = await query(
        `SELECT * FROM sprints WHERE status = 'active' AND end_date = CURRENT_DATE + 1`
      );

      if (result.rows.length === 0) return;

      for (const sprint of result.rows) {
        try {
          // Per-admin local-time gate: send warning only at local 5pm,
          // once per sprint per day.
          const clock = await this._localClockFor(sprint.team_admin_phone);
          if (clock.hour !== 17) continue;
          if (!this._lastEndWarningSent) this._lastEndWarningSent = new Map();
          const key = `${sprint.id}:${clock.dateStr}`;
          if (this._lastEndWarningSent.get(sprint.team_admin_phone) === key) continue;
          this._lastEndWarningSent.set(sprint.team_admin_phone, key);

          const message = `Sprint '${sprint.name}' ends tomorrow!\n` +
            `${sprint.incomplete_count} items still open.`;

          const sprintName = sprint.name || 'Unnamed';
          const progress = `${sprint.incomplete_count} items open`;
          const daysLeft = '1';
          await sendWithTemplateFallback(sprint.team_admin_phone, message, TEMPLATES.SPRINT_UPDATE, [sprintName, progress, daysLeft]);

          logger.info(`Sprint end warning sent to ${sprint.team_admin_phone} for sprint "${sprint.name}"`);
        } catch (error) {
          logger.error(`Failed to send sprint end warning for sprint ${sprint.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('checkSprintEndWarnings error:', error.message);
    } finally {
      this.isRunningEndWarning = false;
    }
  }
}

module.exports = new SprintJob();
