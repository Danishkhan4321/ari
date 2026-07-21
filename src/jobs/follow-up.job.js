const cron = require('node-cron');
const followUpService = require('../services/follow-up.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class FollowUpJob {

  constructor() {
    this.isRunning = false;
  }

  start() {
    // Check for due follow-ups every minute
    cron.schedule('* * * * *', async () => {
      try {
        await this.checkDueFollowUps();
      } catch (error) {
        logger.error('Follow-up job error:', error.message);
      }
    });

    // Initial check after delay
    setTimeout(() => this.checkDueFollowUps(), 5000);

    logger.info('Follow-up job started - checking every minute');
  }

  async checkDueFollowUps() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const dueFollowUps = await followUpService.getDueFollowUps();

      if (!dueFollowUps || dueFollowUps.length === 0) return;

      logger.info(`Found ${dueFollowUps.length} due follow-up(s)`);

      for (const followUp of dueFollowUps) {
        try {
          const message = `*Follow-up Reminder*\n\nContact: ${followUp.contact_name}\nSubject: ${followUp.subject}\nPriority: ${followUp.priority}`;

          await sendWithTemplateFallback(followUp.user_phone, message, TEMPLATES.FOLLOW_UP_CONTACT, [followUp.contact_name, followUp.subject, followUp.priority]);

          await followUpService.markReminderSent(followUp.id, followUp.user_phone);

          logger.info(`Follow-up #${followUp.id} reminder sent to ${followUp.user_phone}`);
        } catch (error) {
          logger.error(`Failed to send follow-up #${followUp.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('checkDueFollowUps error:', error.message);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new FollowUpJob();
