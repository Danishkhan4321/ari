const axios = require('axios');
const { query } = require('../config/database');
const messagingService = require('./messaging.service');
const accountLinkService = require('./account-link.service');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

class AutoUpdateService {

  constructor() {
    this.currentVersion = this.loadCurrentVersion();
    this.updateCheckInterval = 6 * 60 * 60 * 1000; // Check every 6 hours
    this.lastCheck = 0;
    this.updateUrl = process.env.UPDATE_CHECK_URL || null;
    this.changelog = [];
  }

  loadCurrentVersion() {
    try {
      const pkgPath = path.join(__dirname, '../../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || '1.0.0';
    } catch (e) {
      return '1.0.0';
    }
  }

  // Ensure version tracking table exists
  async ensureTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS app_updates (
          id SERIAL PRIMARY KEY,
          version VARCHAR(20) NOT NULL,
          features JSONB DEFAULT '[]',
          release_notes TEXT,
          released_at TIMESTAMP DEFAULT NOW(),
          notified_users JSONB DEFAULT '[]'
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS user_feature_flags (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          feature_name VARCHAR(100) NOT NULL,
          enabled BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_phone, feature_name)
        )
      `);
    } catch (e) {
      logger.error('Auto-update table error:', e.message);
    }
  }

  // Register a new version with features
  async registerVersion(version, features, releaseNotes) {
    await this.ensureTable();
    try {
      await query(
        `INSERT INTO app_updates (version, features, release_notes)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [version, JSON.stringify(features), releaseNotes]
      );
      logger.info(`Registered version ${version}`);
    } catch (e) {
      logger.error('Register version error:', e.message);
    }
  }

  // Check for updates and notify users who haven't been notified
  async checkAndNotifyUsers() {
    await this.ensureTable();
    try {
      // Get latest version entry
      const result = await query(
        `SELECT * FROM app_updates ORDER BY released_at DESC LIMIT 1`
      );

      if (result.rows.length === 0) return;

      const latest = result.rows[0];
      if (latest.version === this.currentVersion) return;

      // Get all active users who haven't been notified
      const usersResult = await query(
        `SELECT DISTINCT user_phone FROM reminders
         UNION
         SELECT DISTINCT user_phone FROM memories
         LIMIT 100`
      );

      const notifiedUsers = latest.notified_users || [];

      // Gradual rollout: notify max 20 users per check cycle
      let notifiedThisCycle = 0;
      const maxPerCycle = 20;

      for (const row of usersResult.rows) {
        if (notifiedUsers.includes(row.user_phone)) continue;
        if (notifiedThisCycle >= maxPerCycle) break; // Gradual rollout

        try {
          const features = latest.features || [];
          let message = `*New Update Available! v${latest.version}*\n\n`;
          message += `*What's new:*\n`;
          features.forEach(f => {
            message += `- ${f}\n`;
          });
          if (latest.release_notes) {
            message += `\n${latest.release_notes}`;
          }
          message += `\n\n_Updates are applied automatically_`;

          const notifyUserId = await accountLinkService.getNotifyUserId(row.user_phone);
          await messagingService.send(notifyUserId, message);
          notifiedUsers.push(row.user_phone);
          notifiedThisCycle++;

          // Delay between messages to avoid WhatsApp rate limits
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
          logger.error(`Failed to notify ${row.user_phone}:`, e.message);
        }
      }

      // Update notified users list
      await query(
        `UPDATE app_updates SET notified_users = $1 WHERE id = $2`,
        [JSON.stringify(notifiedUsers), latest.id]
      );

    } catch (error) {
      logger.error('Update check error:', error.message);
    }
  }

  // Check if a feature is enabled for a user
  async isFeatureEnabled(userPhone, featureName) {
    try {
      const result = await query(
        `SELECT enabled FROM user_feature_flags WHERE user_phone = $1 AND feature_name = $2`,
        [userPhone, featureName]
      );
      if (result.rows.length === 0) return true; // Default: enabled
      return result.rows[0].enabled;
    } catch (e) {
      return true;
    }
  }

  // Toggle feature for a user
  async toggleFeature(userPhone, featureName, enabled) {
    await this.ensureTable();
    try {
      await query(
        `INSERT INTO user_feature_flags (user_phone, feature_name, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_phone, feature_name) DO UPDATE SET enabled = $3`,
        [userPhone, featureName, enabled]
      );
      return true;
    } catch (e) {
      logger.error('Toggle feature error:', e.message);
      return false;
    }
  }

  // Get current version info
  getVersionInfo() {
    return {
      version: this.currentVersion,
      features: [
        'Unlimited reminders',
        'Recurring reminders',
        'Reminder to friend',
        'Voice note transcription',
        'Image recognition',
        'Google & Outlook Calendar',
        'Apple Calendar (CalDAV)',
        'Custom lists',
        'Batch reminders',
        'Web dashboard',
        '100+ language support',
        'Real-time sync',
        'End-to-end encryption',
        'Advanced search'
      ]
    };
  }

  // Start periodic update checks.
  //
  // Both timers are .unref()'d so they don't keep the event loop alive on
  // SIGTERM/SIGINT — graceful shutdown should be able to exit even if the
  // 6-hour interval is sitting idle. Async work fired by the timer is
  // wrapped in .catch so a transient failure can't escape as an
  // unhandledRejection.
  startPeriodicCheck() {
    // Check on startup after 30 seconds
    const startupTimer = setTimeout(() => {
      Promise.resolve(this.checkAndNotifyUsers()).catch((err) => {
        logger.error(`[AutoUpdate] Startup check failed: ${err.message}`);
      });
    }, 30000);
    if (startupTimer.unref) startupTimer.unref();

    // Then check every 6 hours
    const periodicTimer = setInterval(() => {
      Promise.resolve(this.checkAndNotifyUsers()).catch((err) => {
        logger.error(`[AutoUpdate] Periodic check failed: ${err.message}`);
      });
    }, this.updateCheckInterval);
    if (periodicTimer.unref) periodicTimer.unref();

    // Hold references so they can be cleared from a future shutdown hook.
    this._startupTimer = startupTimer;
    this._periodicTimer = periodicTimer;

    logger.info('Auto-update check service started');
  }

  // Stop the periodic check timers. Called from src/index.js shutdown
  // sequence so an SIGTERM can exit cleanly even if a check is mid-run.
  stop() {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._periodicTimer) clearInterval(this._periodicTimer);
    this._startupTimer = null;
    this._periodicTimer = null;
  }
}

module.exports = new AutoUpdateService();
