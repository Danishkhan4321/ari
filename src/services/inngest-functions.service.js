/**
 * Inngest durable function definitions.
 *
 * Each function here registers itself with the Inngest service at startup
 * (when INNGEST_ENABLED=true). They encapsulate our fragile long-running
 * flows so that a PM2 restart or server crash mid-flight can pick up
 * exactly where it left off — no data loss, no double-sends.
 *
 * Pattern: every side-effect (send email, update DB, wait) is wrapped in
 * `step.run(...)` or `step.sleep(...)`. Inngest checkpoints each step;
 * only un-checkpointed steps re-run on resume.
 *
 * Currently defined:
 *   - briefing/daily.requested → per-user durable daily briefing
 *
 * Apr 30 2026 — removed: visa/bulk-send.requested, visa/batch-build.requested,
 * resume/parse.requested. The visa profile builder feature moved to a
 * separate bot. Restore from the pre-visa-removal git tag if needed.
 */

const logger = require('../utils/logger');
const inngestService = require('./inngest.service');

// Apr 30 2026 — three visa-related Inngest function definitions removed
// (defineBulkSend, defineBatchBuild, defineResumeParse). Visa profile
// builder feature moved to a separate bot. The events visa/bulk-send.requested,
// visa/batch-build.requested, and resume/parse.requested no longer have
// handlers — any stale event will fail-fast with "function not found",
// which is the desired behaviour after a feature retirement.

/**
 * Durable daily briefing per-user send.
 *
 * Why this matters: today's briefing cron loops over enabled users and
 * sends each their briefing inline. If the worker crashes at user #23
 * of 50, users 24-50 silently miss their briefing that day. With this:
 *
 *   Cron → for each due user: emit `briefing/daily.requested`
 *   Inngest → receives event per-user → generates + sends briefing
 *
 * A crash now only affects the one user currently being processed;
 * that one gets retried automatically. All other users are unaffected.
 *
 * Event payload: { userPhone, localDateStr }
 */
function defineDailyBriefing() {
  inngestService.registerFunction({
    id: 'daily-briefing',
    name: 'Daily morning briefing (durable, per-user)',
    event: 'briefing/daily.requested',
    retries: 2,
    handler: async ({ event, step }) => {
      const { userPhone, localDateStr } = event.data;
      const briefingService = require('./briefing.service');
      const messagingService = require('./messaging.service');
      const { query } = require('../config/database');

      // Step 1: generate and send tasks/meetings/reminders message
      await step.run('send-tasks-msg', async () => {
        const msg = await briefingService.generateDailyBriefing(userPhone, { includeNews: false });
        if (msg) await messagingService.send(userPhone, msg);
        return { sent: !!msg };
      });

      // Step 2: small durable pause so the user sees 2 separate bubbles
      await step.sleep('inter-message-pause', '3s');

      // Step 3: generate + send top-10 world news
      await step.run('send-news-msg', async () => {
        const newsMsg = await briefingService.generateNewsBriefing(userPhone);
        if (newsMsg) await messagingService.send(userPhone, newsMsg);
        return { sent: !!newsMsg };
      });

      // Step 4: idempotency marker — record "sent today in user's local date"
      await step.run('mark-sent', async () => {
        await query(
          `UPDATE user_settings SET briefing_last_sent_date = $2, updated_at = NOW()
           WHERE user_phone = $1`,
          [userPhone, localDateStr]
        ).catch(() => {});
        return { marked: true };
      });

      return { ok: true };
    }
  });
}

/**
 * Register all durable functions at startup. Called from index.js once
 * all services are loaded. Falls through as no-op if Inngest is disabled.
 */
function registerAll() {
  if (!inngestService.isEnabled()) return;
  try {
    defineDailyBriefing();
    logger.info('Inngest: all durable functions registered');
  } catch (e) {
    logger.error(`Inngest: failed to register functions: ${e.message}`);
  }
}

module.exports = { registerAll };
