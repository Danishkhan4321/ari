const cron = require('node-cron');
const standupService = require('../services/standup.service');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const leaveService = require('../services/leave.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class StandupJob {

  constructor() {
    this.digestSentToday = new Set();
    this.reminderSentToday = new Set();
    this.isRunningQuestions = false;
    this.isRunningDigests = false;
    this.isRunningReminders = false;
  }

  async start() {
    // Check for due standups every minute
    cron.schedule('* * * * *', async () => {
      try {
        await this.checkAndSendStandups();
      } catch (error) {
        logger.error('Standup send job error:', error.message);
      }
    });

    // Check for ready digests every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        await this.checkAndSendDigests();
      } catch (error) {
        logger.error('Standup digest job error:', error.message);
      }
    });

    // Check for deadline reminders every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        await this.checkAndSendReminders();
      } catch (error) {
        logger.error('Standup reminder job error:', error.message);
      }
    });

    // Reset digest and reminder tracking at midnight
    cron.schedule('0 0 * * *', () => {
      this.digestSentToday.clear();
      this.reminderSentToday.clear();
    });

    logger.info('Standup job started - checking every minute for questions, every 5 min for digests/reminders');
  }

  async checkAndSendStandups() {
    if (this.isRunningQuestions) return;
    this.isRunningQuestions = true;
    try {
      const dueStandups = await standupService.getDueStandups();

      for (const config of dueStandups) {
        const members = config.members;
        const questions = config.questions;

        if (!members || members.length === 0 || !questions || questions.length === 0) continue;

        // Auto-excuse members on leave
        const memberPhones = members.map(m => m.phone);
        let onLeavePhones = new Set();
        try {
          const onLeaveList = await leaveService.getMembersOnLeaveToday(memberPhones);
          onLeavePhones = new Set(onLeaveList.map(m => m.phone || m));
        } catch (e) {
          logger.warn('Could not check leave status for standup:', e.message);
        }

        logger.info(`Sending standup "${config.name}" to ${members.length} members (${onLeavePhones.size} on leave)`);

        // Rate-limit standup broadcasts. A 50-member team firing all sends
        // in parallel can trip WhatsApp Cloud's 80-msg/sec template ceiling
        // and trigger a temporary block on the entire phone number. We
        // pace at ~10 messages/sec by inserting a 100ms gap between sends.
        // Tunable via STANDUP_SEND_SPACING_MS.
        const SPACING_MS = parseInt(process.env.STANDUP_SEND_SPACING_MS || '100', 10);
        for (const member of members) {
          try {
            // Skip members on leave — record __on_leave__ marker instead
            if (onLeavePhones.has(member.phone)) {
              await standupService.recordResponse(config.id, member.phone, -1, '__on_leave__');
              logger.info(`Standup skipped for ${member.name} (on leave)`);
              continue;
            }

            const notifyUserId = await accountLinkService.getNotifyUserId(member.phone);
            // Smart standup: different message for morning vs evening
            let message;
            if (config.standup_group_id) {
              const prefix = config.checkpoint_type === 'morning'
                ? `*${config.name}* — Morning Check-in ☀️`
                : `*${config.name}* — Evening Wrap-up 🌙`;
              message = `${prefix}\n\n*${questions[0]}*\n\n_Reply with your answer_`;
            } else {
              message = `*${config.name}*\n\nQuestion 1/${questions.length}:\n*${questions[0]}*\n\n_Reply with your answer_`;
            }
            const tpl = config.checkpoint_type === 'evening' ? TEMPLATES.STANDUP_EVENING : TEMPLATES.STANDUP_MORNING;
            await sendWithTemplateFallback(notifyUserId, message, tpl, [config.name]);

            // Create a placeholder response entry so getDueStandups won't resend
            await standupService.recordResponse(config.id, member.phone, -1, '__placeholder__');

            logger.info(`Standup question sent to ${member.name} (${member.phone})`);

            if (SPACING_MS > 0) {
              await new Promise(r => setTimeout(r, SPACING_MS));
            }
          } catch (error) {
            logger.error(`Failed to send standup to ${member.phone}:`, error.message);
          }
        }
      }
    } catch (error) {
      logger.error('checkAndSendStandups error:', error.message);
    } finally {
      this.isRunningQuestions = false;
    }
  }

  async checkAndSendDigests() {
    if (this.isRunningDigests) return;
    this.isRunningDigests = true;
    try {
      const { query: dbQuery } = require('../config/database');
      const result = await dbQuery(`SELECT * FROM standup_configs WHERE is_active = TRUE`);

      const today = new Date().toISOString().split('T')[0];

      for (const config of result.rows) {
        if (this.digestSentToday.has(`${config.id}-${today}`)) continue;

        // Check if there are any responses today (means standup was triggered)
        const responses = await dbQuery(
          `SELECT DISTINCT member_phone FROM standup_responses
           WHERE config_id = $1 AND response_date = $2 AND question_index >= 0`,
          [config.id, today]
        );

        if (responses.rows.length === 0) continue; // No standup today

        // Check if all members have completed or 4hr timeout
        const members = config.members;
        const respondedMembers = responses.rows.map(r => r.member_phone);
        const allResponded = members.every(m => respondedMembers.includes(m.phone));

        // Check 4hr timeout from first response
        const firstResponse = await dbQuery(
          `SELECT MIN(created_at) as first_at FROM standup_responses
           WHERE config_id = $1 AND response_date = $2 AND question_index >= 0`,
          [config.id, today]
        );

        const firstAt = firstResponse.rows[0]?.first_at;
        const hoursSinceFirst = firstAt ? (Date.now() - new Date(firstAt).getTime()) / (1000 * 60 * 60) : 0;
        const timeoutHours = parseFloat(config.timeout_hours) || 4;
        const timedOut = hoursSinceFirst >= timeoutHours;

        if (allResponded || timedOut) {
          // Smart standup: only send digest for the EVENING config (not morning)
          if (config.standup_group_id && config.checkpoint_type === 'morning') {
            this.digestSentToday.add(`${config.id}-${today}`);
            continue; // Skip morning digest — evening digest covers everything
          }

          let digest;
          if (config.standup_group_id && config.checkpoint_type === 'evening') {
            digest = await this.compileSmartDigest(config);
          } else {
            digest = await standupService.compileDigest(config.id);
          }

          if (digest) {
            // Send to ALL admins (primary + additional)
            const admins = config.standup_group_id
              ? await standupService.getGroupAdmins(config.standup_group_id)
              : [config.admin_phone];

            // Count how many members responded today so the standup_team_digest
            // template's "Responded: {{2}}" param shows a real ratio (e.g. "3/5").
            let respondedLabel = today;
            try {
              const { query } = require('../config/database');
              const countRes = await query(
                `SELECT COUNT(DISTINCT member_phone) AS n FROM standup_responses
                 WHERE config_id = $1 AND response_date = $2`,
                [config.id, today]
              );
              const respondedCount = Number(countRes.rows?.[0]?.n || 0);
              const totalMembers = Array.isArray(config.members) ? config.members.length : 0;
              respondedLabel = totalMembers > 0
                ? `${respondedCount}/${totalMembers}`
                : String(respondedCount);
            } catch (countErr) {
              logger.warn(`Could not compute standup responded count: ${countErr.message}`);
            }

            for (const adminPhone of admins) {
              try {
                const adminNotifyId = await accountLinkService.getNotifyUserId(adminPhone);
                await sendWithTemplateFallback(adminNotifyId, digest, TEMPLATES.STANDUP_DIGEST, [config.team_name || 'default', respondedLabel, digest.slice(0, 500)]);
                logger.info(`Standup digest sent for "${config.name}" to admin ${adminPhone} (responded ${respondedLabel})`);
              } catch (error) {
                logger.error(`Failed to send digest to ${adminPhone}:`, error.message);
              }
            }
            this.digestSentToday.add(`${config.id}-${today}`);
          }
        }
      }
    } catch (error) {
      logger.error('checkAndSendDigests error:', error.message);
    } finally {
      this.isRunningDigests = false;
    }
  }
  async compileSmartDigest(config) {
    const groupId = config.standup_group_id;
    const today = new Date().toISOString().split('T')[0];
    const members = Array.isArray(config.members) ? config.members : JSON.parse(config.members || '[]');

    const analyses = await standupService.getTodayAnalysis(groupId);
    const analysisMap = {};
    for (const a of analyses) analysisMap[a.member_phone] = a;

    let totalAlignment = 0;
    let respondedCount = 0;
    const memberLines = [];

    for (const member of members) {
      const a = analysisMap[member.phone];
      if (a) {
        respondedCount++;
        totalAlignment += a.alignment_score;
        memberLines.push(
          `*${member.name}* — ${a.alignment_score}% alignment\n` +
          `✅ ${(a.completed || []).length} done ❌ ${(a.missed || []).length} missed 🆕 ${(a.unplanned || []).length} unplanned`
        );
      } else {
        memberLines.push(`*${member.name}* — No evening response`);
      }
    }

    const teamAlignment = respondedCount > 0 ? Math.round(totalAlignment / respondedCount) : 0;

    let digest = `📋 *${config.name}* — Team Report\n`;
    digest += `${today}\n\n`;
    digest += `👥 ${respondedCount}/${members.length} responded\n\n`;
    digest += memberLines.join('\n\n');
    digest += `\n\n📊 Team alignment: ${teamAlignment}%`;

    return digest;
  }

  async checkAndSendReminders() {
    if (this.isRunningReminders) return;
    this.isRunningReminders = true;
    try {
      const { query: dbQuery } = require('../config/database');
      const result = await dbQuery(`SELECT * FROM standup_configs WHERE is_active = TRUE`);

      const today = new Date().toISOString().split('T')[0];

      for (const config of result.rows) {
        const reminderKey = `${config.id}-${today}`;
        if (this.reminderSentToday.has(reminderKey)) continue;
        if (this.digestSentToday.has(`${config.id}-${today}`)) continue;

        // Check if there are any responses today (means standup was triggered)
        const responses = await dbQuery(
          `SELECT DISTINCT member_phone FROM standup_responses
           WHERE config_id = $1 AND response_date = $2 AND question_index >= 0`,
          [config.id, today]
        );

        if (responses.rows.length === 0) continue;

        // Check hours since first response
        const firstResponse = await dbQuery(
          `SELECT MIN(created_at) as first_at FROM standup_responses
           WHERE config_id = $1 AND response_date = $2 AND question_index >= 0`,
          [config.id, today]
        );

        const firstAt = firstResponse.rows[0]?.first_at;
        if (!firstAt) continue;

        const hoursSinceFirst = (Date.now() - new Date(firstAt).getTime()) / (1000 * 60 * 60);
        const timeoutHours = parseFloat(config.timeout_hours) || 4;

        // Send reminder when 1 hour before deadline
        if (hoursSinceFirst < (timeoutHours - 1)) continue;

        // Find non-responders
        const members = config.members || [];
        const respondedPhones = new Set(responses.rows.map(r => r.member_phone));
        const nonResponders = members.filter(m => !respondedPhones.includes(m.phone) && !respondedPhones.has(m.phone));

        if (nonResponders.length === 0) continue;

        for (const member of nonResponders) {
          try {
            // Skip members marked as on leave
            const leaveCheck = await dbQuery(
              `SELECT 1 FROM standup_responses WHERE config_id = $1 AND member_phone = $2 AND response_date = $3 AND answer = '__on_leave__'`,
              [config.id, member.phone, today]
            );
            if (leaveCheck.rows.length > 0) continue;

            const notifyUserId = await accountLinkService.getNotifyUserId(member.phone);
            const reminderMsg = `⏰ Reminder: Your standup *${config.name}* closes in ~1 hour! Please respond.`;
            await sendWithTemplateFallback(notifyUserId, reminderMsg, TEMPLATES.STANDUP_MORNING, [config.name]);
          } catch (e) {
            logger.warn(`Standup reminder failed for ${member.phone}:`, e.message);
          }
        }

        this.reminderSentToday.add(reminderKey);
        logger.info(`Sent standup reminders for "${config.name}" to ${nonResponders.length} non-responders`);
      }
    } catch (error) {
      logger.error('checkAndSendReminders error:', error.message);
    } finally {
      this.isRunningReminders = false;
    }
  }
}

module.exports = new StandupJob();
