'use strict';

const cron = require('node-cron');
const replyTrackerService = require('../services/reply-tracker.service');
const gmailService = require('../services/gmail.service');
const googleAuthService = require('../services/google-auth.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');

const LOG_PREFIX = '[ReplyTracker]';

class ReplyTrackerJob {
  constructor() {
    this.isRunning = false;
  }

  start() {
    // PHASE 1: disabled. Reply tracking needs gmail.readonly to detect
    // incoming replies (RESTRICTED → CASA required). Dropped to ship
    // Option A. Re-enable in Phase 2 after CASA is funded.
    //
    // Set REPLY_TRACKER_ENABLED=true to re-enable for local testing only.
    if (process.env.REPLY_TRACKER_ENABLED !== 'true') {
      logger.info(`${LOG_PREFIX} Cron NOT scheduled — disabled in Phase 1 (gmail.readonly scope dropped pending CASA). Set REPLY_TRACKER_ENABLED=true to re-enable for testing.`);
      return;
    }
    // Every 30 minutes. Catch any unhandled rejection from the async tick
    // so it can't leak as an unhandledRejection event.
    cron.schedule('*/30 * * * *', () => {
      this.checkTrackedEmails().catch((err) => {
        logger.error(`${LOG_PREFIX} Unhandled error in cron tick: ${err.message}`);
      });
    });
    logger.info(`${LOG_PREFIX} Cron scheduled (every 30 min)`);
  }

  async checkTrackedEmails() {
    if (this.isRunning) {
      logger.info(`${LOG_PREFIX} Already running, skipping`);
      return;
    }

    this.isRunning = true;

    try {
      // Step 1: Check for early replies on active tracking (within wait window)
      await this.sweepEarlyReplies();

      // Step 2: Process emails past their wait window — notify if no reply
      await this.notifyUnreplied();
    } catch (error) {
      logger.error(`${LOG_PREFIX} Job error: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sweep active tracked emails to detect replies that arrived before the wait window.
   * This prevents false-positive notifications.
   */
  async sweepEarlyReplies() {
    try {
      const active = await replyTrackerService.getActiveTracking();
      if (active.length === 0) return;

      let repliesFound = 0;

      for (const tracked of active) {
        try {
          const connected = await googleAuthService.isConnected(tracked.user_phone);
          if (!connected) continue;

          const result = await gmailService.checkForReply(
            tracked.user_phone,
            tracked.gmail_thread_id,
            tracked.sent_at
          );

          if (result.hasReply) {
            await replyTrackerService.markReplyReceived(tracked.id);
            repliesFound++;
          }
        } catch (err) {
          logger.warn(`${LOG_PREFIX} Early reply check failed for ${tracked.id}: ${err.message}`);
        }
      }

      if (repliesFound > 0) {
        logger.info(`${LOG_PREFIX} Early sweep: found ${repliesFound} replies out of ${active.length} tracked`);
      }
    } catch (err) {
      logger.warn(`${LOG_PREFIX} Early reply sweep error: ${err.message}`);
    }
  }

  /**
   * Process emails that are past their wait window.
   * Check for reply one last time, then notify user if no reply found.
   */
  async notifyUnreplied() {
    try {
      const due = await replyTrackerService.getTrackingDue();
      if (due.length === 0) return;

      logger.info(`${LOG_PREFIX} ${due.length} email(s) past wait window`);

      for (const tracked of due) {
        try {
          const connected = await googleAuthService.isConnected(tracked.user_phone);
          if (!connected) {
            logger.warn(`${LOG_PREFIX} Skipping ${tracked.user_phone} — Google disconnected`);
            continue;
          }

          // Final check — maybe they replied since last sweep
          const result = await gmailService.checkForReply(
            tracked.user_phone,
            tracked.gmail_thread_id,
            tracked.sent_at
          );

          if (result.hasReply) {
            await replyTrackerService.markReplyReceived(tracked.id);
            continue;
          }

          // No reply — notify user
          const hoursAgo = Math.round((Date.now() - new Date(tracked.sent_at).getTime()) / 3600000);
          const recipientDisplay = tracked.recipient_name || tracked.recipient_email;
          const subjectDisplay = tracked.subject ? `"${tracked.subject}"` : 'your email';

          const message =
            `*No reply detected* 📩\n\n` +
            `No reply from *${recipientDisplay}* on ${subjectDisplay} sent ${hoursAgo} hours ago.\n\n` +
            `_Reply "follow up with ${tracked.recipient_email}" to send a follow-up._`;

          await messagingService.send(tracked.user_phone, message);
          await replyTrackerService.markNotified(tracked.id);

          logger.info(`${LOG_PREFIX} Notified ${tracked.user_phone} — no reply from ${tracked.recipient_email}`);
        } catch (err) {
          logger.error(`${LOG_PREFIX} Notify error for ${tracked.id}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`${LOG_PREFIX} notifyUnreplied error: ${err.message}`);
    }
  }
}

module.exports = new ReplyTrackerJob();
