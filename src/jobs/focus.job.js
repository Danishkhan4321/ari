const cron = require('node-cron');
const focusService = require('../services/focus.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class FocusJob {

  constructor() {
    this.isRunning = false;
  }

  start() {
    // Check for expired focus sessions every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
      try {
        await this.checkExpiredSessions();
      } catch (error) {
        logger.error('Focus job error:', error.message);
      }
    });

    // Initial check after delay
    setTimeout(() => this.checkExpiredSessions(), 5000);

    logger.info('Focus job started - checking every 30 seconds');
  }

  async checkExpiredSessions() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const expiredSessions = await focusService.getExpiredSessions();

      if (!expiredSessions || expiredSessions.length === 0) return;

      logger.info(`Found ${expiredSessions.length} expired focus session(s)`);

      for (const session of expiredSessions) {
        try {
          await focusService.completeExpiredSession(session.id);

          let message = `Focus session complete!\n\nDuration: ${session.duration} mins\nMode: ${session.mode}\nLabel: ${session.label}\n\nGreat work! Take a short break.`;

          if (session.mode === 'pomodoro') {
            message += `\n\nPomodoro tip: Take a 5-min break, then start another session!`;
          }

          await sendWithTemplateFallback(session.user_phone, message, TEMPLATES.FOCUS_SESSION, [session.duration + ' mins', session.label || session.mode || 'Focus']);

          logger.info(`Focus session #${session.id} completed and notified ${session.user_phone}`);
        } catch (error) {
          logger.error(`Failed to process expired focus session #${session.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('checkExpiredSessions error:', error.message);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new FocusJob();
