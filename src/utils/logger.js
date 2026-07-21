/**
 * Structured logger — pino-based with a winston-compatible public API.
 *
 * Why pino:
 *  - ~5x faster than winston per upstream benchmarks
 *  - JSON-native (easy to ingest into log aggregators)
 *  - Built-in redaction of common secrets (auth headers, tokens, keys)
 *
 * Why winston-compatible API:
 *  - ~30 existing services call logger.info(msg, meta) and logger.security(event, details)
 *  - We preserve that shape so no callsite has to change
 *
 * NOTE: pino's idiomatic signature is logger.info({ x: 1 }, 'msg'), but winston
 * accepts logger.info('msg', { x: 1 }). We normalize: if the first arg is a
 * string, we call pino with (obj-or-undefined, message) so existing patterns
 * keep working.
 *
 * Transport choice: we use pino's direct stream API (no worker-thread transports)
 * because pino-pretty and pino/file via `pino.transport({...})` have
 * cross-platform issues (Windows worker threads, PM2 fork-mode, etc). The
 * trade-off: logging is synchronous. Still ~3-4x faster than winston per
 * benchmarks, and much more reliable.
 */

const pino = require('pino');
const path = require('path');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';
const logsDir = path.resolve(process.cwd(), 'logs');

// Sentry hook — mirrors error-level logs to Sentry when DSN is configured.
// Lazy-required to avoid circular init with utils/sentry.
let sentryMod = null;
function sentry() {
  if (sentryMod === null) {
    try { sentryMod = require('./sentry'); } catch (e) { sentryMod = false; }
  }
  return sentryMod || null;
}

// ── Stream setup ────────────────────────────────────────────────────────────
// ALL environments: JSON to stdout (PM2 / desktop service manager) + persistent
// files. Files used to be production-only, which meant desktop-run bots (no
// NODE_ENV) kept no logs at all — so user-reported bugs ("Ari said X at 1:15")
// were undiagnosable after the fact. Set LOG_TO_FILES=false to opt out.
let stream;

if (process.env.LOG_TO_FILES !== 'false') {
  // Ensure logs dir exists so fs.createWriteStream doesn't ENOENT.
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) { /* already exists */ }

  // Multi-destination: stdout + combined.log (persistent) + error.log.
  const fileLevel = isProduction ? 'info' : 'debug';
  const streams = [
    { level: fileLevel, stream: process.stdout },
    { level: fileLevel, stream: fs.createWriteStream(path.join(logsDir, 'combined.log'), { flags: 'a' }) },
    { level: 'error', stream: fs.createWriteStream(path.join(logsDir, 'error.log'), { flags: 'a' }) }
  ];
  stream = pino.multistream(streams);
} else {
  // Opt-out path: plain stdout only.
  // Avoid pino.transport({target: 'pino-pretty'}) because its worker thread has
  // Windows issues.
  stream = process.stdout;
}

const pinoLogger = pino(
  {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    base: { service: 'ari' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.access_token',
        '*.refresh_token',
        '*.password',
        '*.secret'
      ],
      censor: '[REDACTED]'
    },
    formatters: {
      level: (label) => ({ level: label })
    }
  },
  stream
);

// ── Winston-compatible wrapper ──────────────────────────────────────────────
// Supports ALL common call patterns from the existing codebase:
//   logger.error(msg)                                 — simple message
//   logger.error(msg, err_obj)                        — winston: error as 2nd arg
//   logger.error(msg, meta_obj)                       — winston: meta as 2nd arg
//   logger.error(msg, string_part)                    — concatenate strings
//   logger.error(msg, string_part, meta_obj)          — 3-arg winston pattern
//   logger.error(msg, err_obj, meta_obj)              — 3-arg with error
//   logger.error({obj}, msg)                          — native pino
//   logger.error(err_obj)                             — just an error
//
// Returns { obj: <merged-meta>, msg: <full-message>, err: <Error|null> }
function normalize(...args) {
  if (args.length === 0) return { obj: undefined, msg: '', err: null };

  let msgParts = [];
  let mergedObj = null;
  let err = null;

  for (const a of args) {
    if (a === undefined || a === null) continue;

    if (a instanceof Error) {
      err = a;
      msgParts.push(a.message || a.name || 'Error');
    } else if (typeof a === 'string') {
      msgParts.push(a);
    } else if (typeof a === 'object') {
      if (mergedObj) {
        mergedObj = { ...mergedObj, ...a };
      } else {
        mergedObj = a;
      }
    } else {
      msgParts.push(String(a));
    }
  }

  const finalObj = err
    ? { ...(mergedObj || {}), err: { message: err.message, stack: err.stack, name: err.name } }
    : mergedObj;

  return {
    obj: finalObj || undefined,
    msg: msgParts.join(' ').trim() || (err ? err.message : ''),
    err
  };
}

const logger = {
  trace(...args) { const { obj, msg } = normalize(...args); obj ? pinoLogger.trace(obj, msg) : pinoLogger.trace(msg); },
  debug(...args) { const { obj, msg } = normalize(...args); obj ? pinoLogger.debug(obj, msg) : pinoLogger.debug(msg); },
  info(...args)  { const { obj, msg } = normalize(...args); obj ? pinoLogger.info(obj, msg)  : pinoLogger.info(msg); },
  warn(...args)  { const { obj, msg } = normalize(...args); obj ? pinoLogger.warn(obj, msg)  : pinoLogger.warn(msg); },
  error(...args) {
    const { obj, msg, err } = normalize(...args);
    if (obj) pinoLogger.error(obj, msg);
    else pinoLogger.error(msg);

    // Mirror errors to Sentry if it's configured.
    const s = sentry();
    if (s && s.Sentry) {
      try {
        if (err) {
          // We have a real Error instance — capture exception with full stack.
          s.captureException(err, { context: msg, ...(obj || {}) });
        } else if (msg && /error|fail|exception|crash/i.test(msg)) {
          // String-only error path — still surface so it groups in Sentry.
          s.Sentry.captureMessage(msg, { level: 'error', extra: obj });
        }
      } catch (e) { /* never let Sentry break logging */ }
    }
  },
  fatal(...args) {
    const { obj, msg, err } = normalize(...args);
    if (obj) pinoLogger.fatal(obj, msg);
    else pinoLogger.fatal(msg);
    const s = sentry();
    if (s && s.Sentry) {
      try {
        if (err) s.captureException(err);
        else s.Sentry.captureMessage(msg, { level: 'fatal', extra: obj });
      } catch (e) { /* noop */ }
    }
  },

  /**
   * Security audit logger — category-tagged warn so these are easy to search/alert on.
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
  security(event, details = {}) {
    pinoLogger.warn(
      { category: 'security', event, ...details },
      `[SECURITY] ${event}`
    );
  }
};

module.exports = logger;
