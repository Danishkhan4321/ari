/**
 * pg-boss durable job queue — backed by the same Postgres as the rest of Ari.
 *
 * Why pg-boss:
 *  - Durable: jobs persist in DB, survive restarts
 *  - Retry with exponential backoff built-in
 *  - Multi-instance safe via SELECT ... FOR UPDATE SKIP LOCKED
 *  - No Redis / external infra — reuses DATABASE_URL
 *
 * Usage:
 *   const boss = require('./config/jobs').getBoss();
 *   await boss.send('queue-name', payload, options);
 *   boss.work('queue-name', { teamSize: 4 }, handler);
 *
 * The boss is started once in src/index.js startServer() after DB connection.
 * Every `work()` handler gets automatic retry + dead-letter semantics.
 */

const logger = require('../utils/logger');

let boss = null;
let starting = false;
let startPromise = null;

async function startBoss() {
  if (boss) return boss;
  if (starting) return startPromise;

  starting = true;

  startPromise = (async () => {
    try {
      // pg-boss v12 exports { PgBoss } as named export. Handle both CJS-default
      // and named-export forms so we don't break when the lib version bumps.
      const mod = require('pg-boss');
      const PgBoss = mod.PgBoss || mod.default || mod;

      // pg-boss requires a SSL-aware connection string. DATABASE_URL from
      // Supabase already includes ?sslmode=require so we don't need to add it.
      boss = new PgBoss({
        connectionString: process.env.DATABASE_URL,
        // Archive completed/failed jobs after 7 days, delete after 30.
        archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
        deleteAfterDays: 30,
        // Monitor & log state changes for visibility.
        monitorStateIntervalSeconds: 60,
        // How often to check for new jobs (default 2s is fine).
        newJobCheckIntervalSeconds: 2,
        // Max concurrent jobs per work() handler by default.
        teamSize: 5,
        teamConcurrency: 1
      });

      boss.on('error', err => {
        logger.error(`pg-boss error: ${err.message}`);
      });

      await boss.start();
      logger.info('pg-boss started (durable job queue ready)');

      return boss;
    } catch (e) {
      logger.error(`pg-boss failed to start: ${e.message}`);
      starting = false;
      startPromise = null;
      boss = null;
      throw e;
    }
  })();

  return startPromise;
}

function getBoss() {
  if (!boss) {
    throw new Error('pg-boss not started — call startBoss() during app init');
  }
  return boss;
}

async function stopBoss() {
  if (boss) {
    try {
      await boss.stop({ graceful: true, timeout: 10000 });
      logger.info('pg-boss stopped');
    } catch (e) {
      logger.warn(`pg-boss stop error: ${e.message}`);
    }
    boss = null;
    starting = false;
    startPromise = null;
  }
}

/**
 * Best-effort check: is pg-boss running and usable?
 * Callers can use this to decide between pg-boss and legacy node-cron paths
 * during the feature-flag rollout.
 */
function isReady() {
  return boss !== null && boss.started !== false;
}

module.exports = { startBoss, getBoss, stopBoss, isReady };
