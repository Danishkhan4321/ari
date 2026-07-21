/**
 * Daily maintenance — once-a-day cleanup of bookkeeping tables that grow
 * unbounded otherwise.
 *
 * Today this prunes:
 *   - processed_messages older than 25 hours (Meta's webhook retry window
 *     is ~24h; 25h gives us a 1h cushion). New in Batch F4; without the
 *     cleanup the table would have millions of rows after a few months.
 *
 * Add more cleanup steps here over time. The job runs at 03:30 UTC by
 * default — late enough to avoid the morning briefing burst, early enough
 * to finish before traffic ramps. Tunable via DAILY_MAINTENANCE_CRON.
 *
 * isRunning guard + advisory lock so a PM2 reload mid-run doesn't double-fire.
 */

const cron = require('node-cron');
const { query, pool } = require('../config/database');
const logger = require('../utils/logger');

class DailyMaintenanceJob {
  constructor() {
    this.isRunning = false;
    this.task = null;
  }

  start() {
    if (process.env.DAILY_MAINTENANCE_ENABLED === 'false') {
      logger.info('[DailyMaintenance] Disabled via env flag');
      return;
    }
    const schedule = process.env.DAILY_MAINTENANCE_CRON || '30 3 * * *';
    this.task = cron.schedule(schedule, () => this.runOnce().catch(err => {
      logger.error('[DailyMaintenance] run error: ' + err.message);
    }));
    logger.info(`[DailyMaintenance] scheduled (${schedule})`);
  }

  stop() {
    if (this.task) { this.task.stop(); this.task = null; }
  }

  async runOnce() {
    if (this.isRunning) {
      logger.warn('[DailyMaintenance] Previous run still in flight — skipping');
      return;
    }
    this.isRunning = true;

    // Cross-process advisory lock — same pattern as reminder.job. Key is a
    // distinct magic number so it can't collide with other cron locks.
    const ADVISORY_KEY = 0x5e51111A; // 'sieliMAINT'
    let lockClient = null;
    try {
      try {
        lockClient = await pool.connect();
        const lr = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_KEY]);
        if (!lr.rows[0]?.got) {
          logger.debug('[DailyMaintenance] Lock busy — another instance is running, skipping');
          return;
        }
      } catch (e) {
        logger.warn(`[DailyMaintenance] Could not acquire advisory lock: ${e.message}`);
        if (lockClient) { try { lockClient.release(); } catch (_) {} lockClient = null; }
      }

      // Remove raw third-party enrichment payloads after 30 days. Applied
      // field-level provenance and citations remain in lead_enrichment_fields.
      try {
        const r = await query(`UPDATE lead_enrichment_items i
          SET input_snapshot='{}'::jsonb, normalized_result=NULL, updated_at=NOW()
          FROM lead_enrichment_jobs j
          WHERE i.job_id=j.id AND j.completed_at < NOW()-INTERVAL '30 days'
            AND (i.normalized_result IS NOT NULL OR i.input_snapshot <> '{}'::jsonb)`);
        logger.info(`[DailyMaintenance] enrichment payloads: cleared ${r.rowCount || 0} rows`);
      } catch (e) {
        if (!/does not exist/i.test(e.message || '')) logger.warn(`[DailyMaintenance] enrichment payload cleanup failed: ${e.message}`);
      }

      const startMs = Date.now();
      logger.info('[DailyMaintenance] Starting');

      // ─── processed_messages prune ──────────────────────────────────────
      // Keep 25h of replay-dedup history. Meta retries failed webhooks for
      // up to 24h; 25h gives 1h of safety margin without bloating the table.
      try {
        const r = await query(
          `DELETE FROM processed_messages
            WHERE processed_at < NOW() - INTERVAL '25 hours'`
        );
        logger.info(`[DailyMaintenance] processed_messages: pruned ${r.rowCount || 0} rows`);
      } catch (e) {
        // Table may not exist yet (first install / dedup hasn't fired) —
        // the lazy-create lives in webhook.controller's catch path.
        if (!/does not exist/i.test(e.message || '')) {
          logger.warn(`[DailyMaintenance] processed_messages prune failed: ${e.message}`);
        }
      }

      // ─── room for future cleanups ───────────────────────────────────────
      // - audit_log retention (keep N days)?
      // - conversation_history archival?
      // - meeting_aws_instances completed rows?
      // Add here when needed.

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      logger.info(`[DailyMaintenance] Done in ${elapsed}s`);
    } finally {
      this.isRunning = false;
      if (lockClient) {
        try { await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]); } catch (_) {}
        try { lockClient.release(); } catch (_) {}
      }
    }
  }
}

module.exports = new DailyMaintenanceJob();
