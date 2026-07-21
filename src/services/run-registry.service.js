'use strict';

// Cancellation authority for agent runs.
//
// dashboardRuns (webhook.routes.js) keys by userId:sessionId for single-flight
// reservation; this registry keys by runId so a Stop request can be resolved
// authoritatively: either it found THE run and aborted it, or it reports
// not_found — never a blind {ok:true}.

const logger = require('../utils/logger');

const MAX_TRACKED_RUNS = 5000; // defensive cap; entries are removed in finally blocks

const runs = new Map();

function register(runId, entry) {
  if (!runId || !entry?.abortController) return false;
  if (runs.size >= MAX_TRACKED_RUNS) {
    // Evict the oldest entry — a leak this size means a finally block is
    // broken somewhere; keep serving rather than grow unbounded.
    const oldest = runs.keys().next().value;
    runs.delete(oldest);
    logger.warn({ evicted: oldest }, 'run-registry hit its cap; evicted oldest entry');
  }
  runs.set(String(runId), { ...entry, registeredAt: Date.now() });
  return true;
}

function get(runId) {
  return runs.get(String(runId)) || null;
}

function unregister(runId) {
  return runs.delete(String(runId));
}

/**
 * Abort a run if it exists and belongs to the given user (and session when
 * provided). Returns { stopped: boolean, code?: string }.
 */
function abort(runId, { userId, sessionId, reason } = {}) {
  const entry = runs.get(String(runId));
  if (!entry) return { stopped: false, code: 'not_found' };
  if (userId && entry.userId !== userId) return { stopped: false, code: 'not_found' };
  if (sessionId && entry.sessionId && entry.sessionId !== sessionId) {
    return { stopped: false, code: 'not_found' };
  }
  entry.cancelled = true;
  try {
    entry.abortController.abort(reason || Object.assign(
      new Error('Run cancelled by the user.'), { code: 'agent_cancelled' },
    ));
  } catch (error) {
    logger.warn({ runId, err: error.message }, 'run-registry abort raised');
  }
  return { stopped: true };
}

function stats() {
  return { active: runs.size };
}

module.exports = { register, get, unregister, abort, stats };
