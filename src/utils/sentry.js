/**
 * Sentry error tracking — initialized as the very first thing in the process.
 *
 * Must be required BEFORE any other module so instrumentation hooks can attach.
 * Fails open: if SENTRY_DSN is not set, the SDK no-ops and nothing is sent.
 *
 * Env:
 *   SENTRY_DSN                 - required to enable reporting
 *   SENTRY_TRACES_SAMPLE_RATE  - default 0.1 (10% of transactions traced)
 *   SENTRY_ENVIRONMENT         - defaults to NODE_ENV or 'development'
 */

const Sentry = require('@sentry/node');

let initialized = false;

function initSentry() {
  if (initialized) return Sentry;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No DSN → Sentry noop. Return the module as-is so calls like
    // Sentry.captureException(...) are safe to make unconditionally.
    initialized = true;
    return Sentry;
  }

  try {
    // Profiling is optional — wrap in try/catch because the native bindings
    // can fail to load on certain Node versions / glibc combos.
    let integrations = [];
    try {
      const { nodeProfilingIntegration } = require('@sentry/profiling-node');
      integrations.push(nodeProfilingIntegration());
    } catch (e) {
      // Profiling unavailable — errors still work.
    }

    Sentry.init({
      dsn,
      integrations,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || '0.1'),
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release: require('../../package.json').version,

      // These are already retried by utils/retry.js — don't spam Sentry with
      // transient network noise.
      ignoreErrors: [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNABORTED',
        'socket hang up',
        'Request failed with status code 429',
        'Request failed with status code 503'
      ],

      // Don't capture health-check or recording-redirect traffic as
      // transactions — these are hit by cron pingers and bots and pollute
      // the performance dashboard.
      beforeSendTransaction(event) {
        const url = event.request?.url || '';
        if (url.includes('/health') || url.includes('/recording/') || url === '/') {
          return null;
        }
        return event;
      }
    });

    initialized = true;
  } catch (e) {
    // Never let Sentry init crash the bot.
    // eslint-disable-next-line no-console
    console.error('Sentry init failed:', e.message);
  }

  return Sentry;
}

/**
 * Attach user + platform context to the current scope so any captured error
 * carries "who was doing what" information.
 * @param {string} userPhone
 * @param {string} platform
 * @param {Record<string, unknown>} [extra]
 */
function setRequestContext(userPhone, platform, extra) {
  try {
    Sentry.getCurrentScope().setUser({ id: userPhone });
    Sentry.getCurrentScope().setTag('platform', platform || 'unknown');
    if (extra) Sentry.getCurrentScope().setContext('message', extra);
  } catch (e) { /* noop */ }
}

/**
 * Capture an exception with structured extras. Use instead of
 * logger.error(err.message) when you want the error to surface in Sentry.
 * @param {unknown} error
 * @param {Record<string, unknown>} [extras]
 */
function captureException(error, extras) {
  try {
    if (extras) {
      Sentry.withScope(scope => {
        for (const [k, v] of Object.entries(extras)) scope.setExtra(k, v);
        Sentry.captureException(error);
      });
    } else {
      Sentry.captureException(error);
    }
  } catch (e) { /* noop */ }
}

module.exports = { Sentry, initSentry, setRequestContext, captureException };
