const cron = require('node-cron');
const pollService = require('../services/poll.service');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const TEMPLATES = require('../config/whatsapp-templates');
const BoundedMap = require('../utils/bounded-map');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const logger = require('../utils/logger');

class PollJob {
  constructor() {
    this.isRunning = false;
    // Apr 29 2026: replaced unbounded Set with a 30-day BoundedMap so this
    // doesn't slowly leak memory. Polls stay in the cron's 'active' filter
    // for at most 30 days under any realistic usage; entries that expire
    // sooner just get re-added on the next reminder cycle (idempotent).
    // Cap is 100k poll IDs which is safely above any plausible volume.
    this.remindersSent = new BoundedMap(100000, 30 * 24 * 60 * 60 * 1000);
  }

  start() {
    // Every 5 minutes, check for polls that need reminders
    cron.schedule('*/5 * * * *', async () => {
      await this.sendNonVoterReminders();
    });
    logger.info('Poll reminder job started - checking every 5 minutes');
  }

  async sendNonVoterReminders() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const { query } = require('../config/database');
      const result = await query(
        `SELECT * FROM polls WHERE status = 'active' AND created_at < NOW() - INTERVAL '1 hour'`
      );

      for (const poll of result.rows) {
        // BoundedMap.has → falsy if expired (TTL eviction returns null on get
        // and false on has). Either way, an evicted entry just resends the
        // reminder, which is harmless given the cron's "older than 1h" gate.
        if (this.remindersSent.has(poll.id)) continue;

        const recipients = poll.recipients || [];
        if (recipients.length === 0) continue;

        const nonVoters = await pollService.getNonVoters(poll.id, recipients);
        if (nonVoters.length === 0) continue;

        // Build options list for both free-form and template params.
        // Template body is "📊 Reminder: Please vote on the poll. {{1}} {{2}}"
        // where {{1}} = question, {{2}} = newline-separated options.
        const optionsList = (poll.options || [])
          .map((opt, i) => `${i + 1}. ${typeof opt === 'string' ? opt : (opt.text || opt.label || opt)}`)
          .join('\n');
        const freeFormText = `📊 *Reminder:* Please vote on the poll:\n\n"${poll.question}"\n\n${optionsList}\n\n_Reply with your option number._`;

        for (const member of nonVoters) {
          try {
            const phone = member.phone || member;
            const notifyId = await accountLinkService.getNotifyUserId(phone);
            // Use sendWithTemplateFallback so non-voters who haven't messaged
            // Ari in 24h still get nudged via the approved POLL_REMINDER
            // template instead of silently failing.
            await sendWithTemplateFallback(
              notifyId,
              freeFormText,
              TEMPLATES.POLL_REMINDER,
              [poll.question, optionsList]
            );

            // RC #4 fix: Refresh pollVoteContext so when the recipient replies
            // with "1", the short-circuit at webhook.controller.js:738-743
            // catches it before the LLM intent detection misroutes it to
            // set_reminder. The context was originally set at broadcast time
            // (pollVoteContext.set), but its TTL expired by the time the
            // reminder fires hours later — leaving the user's "1" reply with
            // nothing to anchor it to a poll.
            try {
              const webhookController = require('../controllers/webhook.controller');
              if (webhookController.pollVoteContext) {
                webhookController.pollVoteContext.set(phone, {
                  pollId: poll.id,
                  timestamp: Date.now(),
                });
              }
            } catch (refreshErr) {
              logger.warn(`Could not refresh pollVoteContext for ${phone}: ${refreshErr.message}`);
            }
          } catch (e) {
            logger.warn(`Poll reminder failed for ${member.phone || member}:`, e.message);
          }
        }

        // BoundedMap.set instead of Set.add — same semantics for "remember this id".
        this.remindersSent.set(poll.id, true);
        logger.info(`Sent poll reminders for poll ${poll.id} to ${nonVoters.length} non-voters`);
      }
    } catch (error) {
      logger.error('Poll reminder job error:', error.message);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new PollJob();
