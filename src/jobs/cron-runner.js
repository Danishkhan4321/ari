/**
 * Unified cron-runner — wraps pg-boss for schedule-based jobs, with
 * automatic fallback to node-cron when pg-boss is unavailable.
 *
 * Problem solved: we have 15 cron jobs. Each one had its own node-cron boilerplate +
 * `isRunning` mutex + try/catch. This helper centralizes that and adds:
 *   - Durable scheduling via pg-boss (jobs survive PM2 restarts)
 *   - Multi-instance safety (SELECT FOR UPDATE SKIP LOCKED in pg-boss)
 *   - Automatic fallback to node-cron if pg-boss failed to start
 *   - Consistent error logging + Sentry breadcrumbs
 *
 * Feature flag: USE_PG_BOSS=true enables pg-boss path. Otherwise uses node-cron.
 *
 * Usage:
 *   const cronRunner = require('./cron-runner');
 *   cronRunner.schedule({
 *     name: 'scheduled-email-check',
 *     cron: '*\/30 * * * * *',     // every 30s
 *     handler: async () => { await scheduledEmailJob.check(); }
 *   });
 */

const nodeCron = require('node-cron');
const logger = require('../utils/logger');

const USE_PG_BOSS = process.env.USE_PG_BOSS === 'true';

// Track what's registered (for /debug + clean shutdown).
const registered = new Map();

/**
 * Register a scheduled job.
 *
 * @param {object} opts
 * @param {string} opts.name - unique queue/job name (e.g. 'scheduled-email-check')
 * @param {string} opts.cron - cron expression (e.g. '* /30 * * * * *')
 * @param {function} opts.handler - async () => void — the work to do per tick
 * @param {number} [opts.teamSize=1] - pg-boss concurrency (default 1 = serial)
 * @returns {Promise<{mode: 'pg-boss'|'node-cron'}>}
 */
async function schedule({ name, cron, handler, teamSize = 1 }) {
  if (!name || !cron || typeof handler !== 'function') {
    throw new Error(`cron-runner.schedule: invalid args for ${name}`);
  }

  if (registered.has(name)) {
    logger.warn(`cron-runner: ${name} already registered, skipping`);
    return registered.get(name);
  }

  // Wrap handler with boilerplate: timing + error logging + re-entrancy guard
  let running = false;
  const wrappedHandler = async () => {
    if (running) {
      logger.debug(`cron-runner: ${name} still running, skipping this tick`);
      return;
    }
    running = true;
    const start = Date.now();
    try {
      await handler();
    } catch (e) {
      logger.error(`cron-runner ${name} error:`, e);
    } finally {
      running = false;
      const elapsed = Date.now() - start;
      if (elapsed > 10000) {
        logger.warn(`cron-runner ${name} slow tick: ${elapsed}ms`);
      }
    }
  };

  // Try pg-boss first if feature flag is on.
  if (USE_PG_BOSS) {
    try {
      const { getBoss, isReady } = require('../config/jobs');
      if (isReady()) {
        const boss = getBoss();

        // pg-boss v10+ requires explicit queue creation before work/schedule.
        // createQueue is idempotent (no-op if exists).
        if (typeof boss.createQueue === 'function') {
          try {
            await boss.createQueue(name);
          } catch (e) {
            // Ignore "already exists" errors
            if (!/already exists/i.test(e.message)) throw e;
          }
        }

        // Workers consume jobs from the queue.
        await boss.work(name, { teamSize, teamConcurrency: 1 }, async () => {
          await wrappedHandler();
        });

        // Schedule creates new jobs on the cron cadence.
        await boss.schedule(name, cron);

        logger.info(`cron-runner: ${name} scheduled via pg-boss (${cron})`);
        const info = { mode: 'pg-boss', name, cron };
        registered.set(name, info);
        return info;
      }
    } catch (e) {
      logger.warn(`cron-runner: pg-boss schedule failed for ${name}, falling back to node-cron: ${e.message}`);
    }
  }

  // Fallback: node-cron in-process.
  nodeCron.schedule(cron, wrappedHandler);
  logger.info(`cron-runner: ${name} scheduled via node-cron (${cron})`);
  const info = { mode: 'node-cron', name, cron };
  registered.set(name, info);
  return info;
}

function list() {
  return Array.from(registered.values());
}

module.exports = { schedule, list };
