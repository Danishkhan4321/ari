/**
 * Turn trace — one durable JSONL record per user turn, for post-hoc debugging.
 *
 * Why: when a user reports "Ari answered X to my message at 1:15 AM", we need
 * to see what the pipeline actually did that turn — which route fired
 * (deterministic / agent loop / single-shot intent / chat fallback), what
 * detectIntent returned, what handler ran, what was sent back, and how long
 * each stage took. PM2/stdout logs are interleaved across users and lost on
 * desktop runs; agent_runs only covers the agentic path. This covers EVERY
 * turn, on every channel, in one greppable file.
 *
 * Pattern follows model-usage-tracker.service.js: append-only JSONL under
 * logs/, in-memory staging via BoundedMap, never throws into the pipeline.
 *
 * File: logs/agent-turns.jsonl — one JSON object per line:
 *   { ts, turnId, userPhone, channel, type, text, events: [{t, stage, data}],
 *     route, response, outcome, error, totalMs }
 *
 * Env:
 *   TURN_TRACE_ENABLED  = 'true' (default) / 'false'
 *   TURN_TRACE_LOG_PATH = path (default: logs/agent-turns.jsonl)
 *   TURN_TRACE_MAX_MB   = rotate threshold in MB (default: 20; keeps one .1)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { currentChatSession, SessionScopedBoundedMap } = require('./chat-session-context');

const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|api[_-]?key|credential)/i;
const MAX_STRING = 1500;
const MAX_EVENTS = 60;

// Strings are truncated and secret-shaped keys redacted so a trace can never
// leak credentials into a file that gets pasted into bug reports.
function sanitize(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitize(item, depth + 1);
    }
    return out;
  }
  return value;
}

function createTurnTraceService(options = {}) {
  const enabled = options.enabled !== undefined
    ? options.enabled
    : process.env.TURN_TRACE_ENABLED !== 'false';
  const logPath = options.logPath
    || process.env.TURN_TRACE_LOG_PATH
    || path.join(process.cwd(), 'logs', 'agent-turns.jsonl');
  const maxBytes = (Number(options.maxMb || process.env.TURN_TRACE_MAX_MB) || 20) * 1024 * 1024;
  const sessionLogDir = options.sessionLogDir || process.env.ARI_SESSION_LOG_DIR || null;
  const now = options.now || Date.now;

  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) { /* exists */ }
  if (sessionLogDir) {
    try { fs.mkdirSync(sessionLogDir, { recursive: true }); } catch (_) { /* exists */ }
  }

  // One active trace per user. The controller serializes turns per user, so
  // the phone is a safe correlation key; if a second turn begins before the
  // first flushed, the first is flushed as 'superseded' rather than lost.
  const active = new SessionScopedBoundedMap(500, 10 * 60 * 1000);
  let writesSinceSizeCheck = 0;
  let warnedWriteFailure = false;

  function rotateIfNeeded(targetPath) {
    // Lazy size check every 50 writes — stat() per turn would be waste.
    if (writesSinceSizeCheck++ < 50) return;
    writesSinceSizeCheck = 0;
    try {
      const size = fs.statSync(targetPath).size;
      if (size > maxBytes) {
        const rotated = `${targetPath}.1`;
        try { fs.unlinkSync(rotated); } catch (_) { /* no previous rotation */ }
        fs.renameSync(targetPath, rotated);
      }
    } catch (_) { /* file may not exist yet */ }
  }

  function flush(trace, extra = {}) {
    const targetPath = trace.sessionId && sessionLogDir
      ? path.join(sessionLogDir, `${trace.sessionId}.jsonl`)
      : logPath;
    const maskedPhone = trace.sessionId
      ? `***${String(trace.userPhone).replace(/\D/g, '').slice(-4)}`
      : trace.userPhone;
    const record = {
      ts: new Date(trace.startedAt).toISOString(),
      turnId: trace.turnId,
      userPhone: maskedPhone,
      ...(trace.sessionId ? {
        sessionId: trace.sessionId,
        clientMessageId: trace.clientMessageId,
        runId: trace.runId,
      } : {}),
      ...trace.meta,
      events: trace.events,
      route: trace.route || null,
      response: trace.response !== undefined ? sanitize(trace.response) : null,
      outcome: extra.outcome || trace.outcome || 'completed',
      error: extra.error || trace.error || null,
      totalMs: now() - trace.startedAt,
    };
    rotateIfNeeded(targetPath);
    fs.appendFile(targetPath, `${JSON.stringify(record)}\n`, (err) => {
      if (err && !warnedWriteFailure) {
        warnedWriteFailure = true; // warn once, not per turn
        logger.warn(`[TurnTrace] append failed (${err.message}) — traces disabled for this run`);
      }
    });
  }

  return {
    enabled,
    logPath,

    /** Start tracing a turn. Flushes any unfinished previous turn for the user. */
    begin(userPhone, meta = {}) {
      if (!enabled || !userPhone) return;
      try {
        const chatSession = currentChatSession();
        const previous = active.get(userPhone);
        if (previous) flush(previous, { outcome: 'superseded' });
        active.set(userPhone, {
          turnId: randomUUID(),
          userPhone,
          startedAt: now(),
          sessionId: chatSession?.sessionId || null,
          clientMessageId: chatSession?.clientMessageId || null,
          runId: chatSession?.runId || null,
          meta: sanitize(meta),
          events: [],
        });
      } catch (_) { /* tracing must never break the pipeline */ }
    },

    /** Record a pipeline event for the user's active turn. No-op without one. */
    note(userPhone, stage, data) {
      if (!enabled || !userPhone) return;
      try {
        const trace = active.get(userPhone);
        if (!trace) return;
        if (trace.events.length >= MAX_EVENTS) return;
        trace.events.push({
          t: now() - trace.startedAt,
          stage,
          ...(data !== undefined ? { data: sanitize(data) } : {}),
        });
        // Route + response are promoted to top-level fields for grep-ability.
        if (stage === 'route' && data && data.route) trace.route = data.route;
        if (stage === 'response_sent' && data && data.response !== undefined) trace.response = data.response;
      } catch (_) { /* never throw */ }
    },

    /** Finish the user's active turn and write it to disk. Idempotent. */
    end(userPhone, fields = {}) {
      if (!enabled || !userPhone) return;
      try {
        const trace = active.get(userPhone);
        if (!trace) return;
        active.delete(userPhone);
        if (fields.response !== undefined) trace.response = fields.response;
        flush(trace, { outcome: fields.outcome, error: fields.error });
      } catch (_) { /* never throw */ }
    },
  };
}

module.exports = {
  createTurnTraceService,
  turnTrace: createTurnTraceService(),
};
