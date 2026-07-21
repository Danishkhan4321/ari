/**
 * Inngest — durable execution layer for long-running flows.
 *
 * What this solves:
 *   Before: if PM2 restarts mid-flight, the in-flight work dies.
 *   We've shipped incomplete batches and lost user-critical processing.
 *
 *   After: every step of a durable flow is checkpointed. Server crashes
 *   at step 7 of 10 → another worker picks up at step 8. Zero data loss,
 *   automatic retries with exponential backoff, full observability.
 *
 * Safe-rollout pattern (used across Ari):
 *   INNGEST_ENABLED=false (default) → no-op; flows run via direct calls
 *   INNGEST_ENABLED=true + keys set → durable execution for marked flows
 *
 * This allows us to migrate flows one at a time and fall back instantly
 * via env flag if anything misbehaves — no code rollback needed.
 *
 * Env required when enabled:
 *   INNGEST_ENABLED=true
 *   INNGEST_EVENT_KEY=<from Inngest dashboard>
 *   INNGEST_SIGNING_KEY=<from Inngest dashboard>
 *   INNGEST_APP_ID=ari  (optional, defaults to 'ari')
 */

const logger = require('../utils/logger');

let Inngest = null;
let client = null;
let functions = [];
let isInitialized = false;

function isEnabled() {
  return String(process.env.INNGEST_ENABLED || 'false').toLowerCase() === 'true';
}

function isConfigured() {
  return isEnabled() && !!process.env.INNGEST_EVENT_KEY;
}

/**
 * Lazy init — only loads the Inngest SDK when the flag is on. Keeps
 * production dependencies lean when the feature is disabled.
 */
function getClient() {
  if (isInitialized) return client;
  isInitialized = true;

  if (!isEnabled()) {
    logger.info('Inngest: disabled via INNGEST_ENABLED=false');
    return null;
  }

  try {
    ({ Inngest } = require('inngest'));
    client = new Inngest({
      id: process.env.INNGEST_APP_ID || 'ari',
      eventKey: process.env.INNGEST_EVENT_KEY || undefined
    });
    logger.info('Inngest: client initialized');
    return client;
  } catch (e) {
    logger.error(`Inngest: init failed: ${e.message}`);
    client = null;
    return null;
  }
}

/**
 * Register an Inngest durable function. Called by service modules that
 * want to opt into durable execution. Returns the function object so
 * it can be added to the serve() registration below.
 */
function registerFunction(fn) {
  if (!isEnabled()) return null;
  const c = getClient();
  if (!c) return null;

  try {
    // Inngest v4+ API: triggers live inside the FIRST argument, not the second.
    // https://www.inngest.com/docs/reference/functions/create#inngest-createFunction-config
    const inngestFn = c.createFunction(
      {
        id: fn.id,
        name: fn.name,
        retries: fn.retries ?? 3,
        triggers: [{ event: fn.event }]
      },
      fn.handler
    );
    functions.push(inngestFn);
    logger.info(`Inngest: registered function ${fn.id}`);
    return inngestFn;
  } catch (e) {
    logger.warn(`Inngest: failed to register ${fn.id}: ${e.message}`);
    return null;
  }
}

/**
 * Emit an event to trigger a durable Inngest function. If Inngest is
 * disabled, the caller should fall back to a direct function call (no-op here).
 *
 * @param {string} name - event name, e.g. 'visa/bulk-send.requested'
 * @param {object} data - event payload
 * @returns {Promise<{ids: string[]}|null>} null if Inngest disabled
 */
async function send(name, data) {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.send({ name, data });
  } catch (e) {
    logger.error(`Inngest: send failed for event ${name}: ${e.message}`);
    return null;
  }
}

/**
 * Returns all registered Inngest functions for Express mounting via
 * the `inngest/express` serve() adapter. See routes/inngest.routes.js.
 */
function getRegisteredFunctions() {
  return [...functions];
}

module.exports = {
  isEnabled,
  isConfigured,
  getClient,
  registerFunction,
  send,
  getRegisteredFunctions
};
