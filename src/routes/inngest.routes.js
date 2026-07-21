/**
 * Inngest HTTP endpoint — receives webhook deliveries from Inngest cloud.
 *
 * Inngest calls this endpoint to:
 *   1. Invoke a registered function when its event fires
 *   2. Resume a paused step after sleep/wait-for-event
 *   3. Re-drive retries on failure
 *
 * Mounted at /api/inngest (configurable via INNGEST_HTTP_PATH env).
 *
 * When INNGEST_ENABLED=false, this route returns 503 — Inngest cloud sees
 * the app is offline and doesn't deliver. Safe default.
 */

const express = require('express');
const inngestService = require('../services/inngest.service');
const logger = require('../utils/logger');

const router = express.Router();

// When disabled, short-circuit all Inngest traffic.
router.all('/', (req, res, next) => {
  if (!inngestService.isEnabled()) {
    return res.status(503).json({ error: 'Inngest not enabled on this server' });
  }
  next();
});

/**
 * Lazy-mount the Inngest serve handler only when the feature is enabled.
 * Because serve() needs the list of registered functions AT app-start
 * time, we mount it once all services have registered their functions.
 */
function mountIfEnabled(app, path = '/api/inngest') {
  if (!inngestService.isEnabled()) {
    logger.info('Inngest route: not mounted (INNGEST_ENABLED=false)');
    return;
  }

  try {
    const { serve } = require('inngest/express');
    const client = inngestService.getClient();
    const fns = inngestService.getRegisteredFunctions();

    if (!client || fns.length === 0) {
      logger.warn(`Inngest route: no client or 0 functions registered — skipping mount`);
      return;
    }

    app.use(path, serve({
      client,
      functions: fns,
      signingKey: process.env.INNGEST_SIGNING_KEY
    }));
    logger.info(`Inngest: webhook handler mounted at ${path} (${fns.length} functions)`);
  } catch (e) {
    logger.error(`Inngest route mount failed: ${e.message}`);
  }
}

module.exports = { router, mountIfEnabled };
