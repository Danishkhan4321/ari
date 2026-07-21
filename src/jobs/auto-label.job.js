'use strict';

const cron = require('node-cron');
const emailPreferencesService = require('../services/email-preferences.service');
const inboxOrganizerService = require('../services/inbox-organizer.service');
const logger = require('../utils/logger');

const LOG_PREFIX = '[AutoLabel]';

// Map AI categories → Gmail label names
const CATEGORY_TO_LABEL = {
  urgent: 'Urgent',
  action_needed: 'Action Needed',
  fyi: 'FYI',
  newsletters: 'Newsletter',
  promotions: 'Promotion',
};

class AutoLabelJob {
  constructor() {
    this.isRunning = false;
  }

  start() {
    // PHASE 1: disabled. Auto-labeling needs gmail.readonly + gmail.modify
    // (both RESTRICTED by Google → require CASA security assessment).
    // We dropped those scopes to ship Option A (sensitive-only OAuth
    // verification). Re-enable in Phase 2 after CASA is funded.
    //
    // To force-enable for local testing only, set AUTOLABEL_ENABLED=true.
    if (process.env.AUTOLABEL_ENABLED !== 'true') {
      logger.info(`${LOG_PREFIX} Cron NOT scheduled — disabled in Phase 1 (gmail.readonly + gmail.modify scopes dropped pending CASA). Set AUTOLABEL_ENABLED=true to re-enable for testing.`);
      return;
    }
    // Every 15 minutes. Wrap the async call in .catch so an unhandled
    // rejection inside processAllUsers can't escape the cron callback (the
    // function already has its own try/catch, but a rejection from anything
    // BEFORE the try — e.g. a require() error — would otherwise leak as an
    // unhandledRejection event).
    cron.schedule('*/15 * * * *', () => {
      this.processAllUsers().catch((err) => {
        logger.error(`${LOG_PREFIX} Unhandled error in cron tick: ${err.message}`);
      });
    });
    logger.info(`${LOG_PREFIX} Cron scheduled (every 15 min)`);
  }

  async processAllUsers() {
    if (this.isRunning) {
      logger.info(`${LOG_PREFIX} Already running, skipping`);
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const users = await emailPreferencesService.getAutoLabelUsers();
      if (users.length === 0) {
        return;
      }

      logger.info(`${LOG_PREFIX} Processing ${users.length} user(s)`);
      let totalLabeled = 0;

      for (const user of users) {
        try {
          const count = await this.processUser(user);
          totalLabeled += count;
        } catch (err) {
          logger.error(`${LOG_PREFIX} Error for ${user.user_phone}: ${err.message}`);
        }
        // Small delay between users to respect API limits
        if (users.length > 1) await new Promise(r => setTimeout(r, 1000));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (totalLabeled > 0) {
        logger.info(`${LOG_PREFIX} Done in ${elapsed}s — labeled ${totalLabeled} email(s) for ${users.length} user(s)`);
      }
    } catch (error) {
      logger.error(`${LOG_PREFIX} Job error: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processUser(user) {
    const { user_phone, last_labeled_email_ts } = user;

    // Fetch unread emails since last run (default: last 24h on first run)
    const emails = await inboxOrganizerService.getUnreadSince(user_phone, last_labeled_email_ts, 20);
    if (emails.length === 0) return 0;

    // Filter out emails that already have one of our labels
    const labelNames = Object.values(CATEGORY_TO_LABEL);
    const filtered = emails.filter(e => {
      // We can't easily check by label name from labelIds (they're IDs not names)
      // So we process all — batchApplyLabels is idempotent (adding same label twice is fine)
      return true;
    });

    if (filtered.length === 0) return 0;

    // Categorize with AI
    const categorized = await inboxOrganizerService.categorizeEmails(filtered);

    // Build label assignments
    const assignments = [];
    for (const [category, categoryEmails] of Object.entries(categorized)) {
      const labelName = CATEGORY_TO_LABEL[category];
      if (!labelName) continue;

      for (const email of categoryEmails) {
        if (email?.id) {
          assignments.push({ messageId: email.id, labelName });
        }
      }
    }

    if (assignments.length === 0) return 0;

    // Apply labels
    const result = await inboxOrganizerService.batchApplyLabels(user_phone, assignments);

    // Update watermark to latest email timestamp
    const latestEmail = filtered.reduce((latest, e) =>
      (!latest || (e.internalDate > latest.internalDate)) ? e : latest, null
    );
    if (latestEmail) {
      await emailPreferencesService.updateLastLabeledEmail(
        user_phone,
        latestEmail.id,
        new Date(parseInt(latestEmail.internalDate))
      );
    }

    logger.info(`${LOG_PREFIX} ${user_phone}: labeled ${result.applied}/${filtered.length} emails`);
    return result.applied;
  }
}

module.exports = new AutoLabelJob();
