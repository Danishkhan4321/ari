'use strict';

// Small helpers for honoring AbortSignal at query boundaries.
//
// Rule: a mutating service checks the signal BEFORE its first write and never
// afterwards — once a write may have reached the database, the outcome stands
// and is journaled; killing it mid-flight is how "stopped" runs still mutate
// records (smoke-test defect C-1).

function throwIfAborted(signal, actionLabel = 'operation') {
  if (!signal?.aborted) return;
  const error = new Error(`${actionLabel} was cancelled before it started.`);
  error.code = 'agent_cancelled';
  error.cause = signal.reason;
  throw error;
}

module.exports = { throwIfAborted };
