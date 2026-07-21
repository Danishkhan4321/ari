'use strict';

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const database = require('../config/database');
const { currentChatSession } = require('./chat-session-context');

const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|api[_-]?key|credential)/i;
const VALID_RUN_STATUSES = new Set([
  'received', 'understanding', 'planning', 'executing', 'waiting_for_approval',
  'waiting_for_user', 'verifying', 'completed', 'partial', 'failed', 'cancelled',
]);
// Runtimes are not required to agree on one spelling for the two pause states.
// The ledger is the single normalization boundary so an approval pause can
// never be recorded as a failure again.
const RUN_STATUS_ALIASES = {
  waiting_approval: 'waiting_for_approval',
  waiting_input: 'waiting_for_user',
};

function redactPayload(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactPayload(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 2000);
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    // Usage-count fields (prompt_tokens, total_tokens, *_tokens_details…)
    // match the sensitive pattern on the word "token" but are billing
    // telemetry, not secrets — redacting them destroyed cost auditing.
    const isTokenCountKey = /_tokens(_details)?$|token_count$/i.test(key) || /[a-z]Tokens$/.test(key);
    out[key] = SENSITIVE_KEY_RE.test(key) && !isTokenCountKey
      ? '[REDACTED]'
      : redactPayload(item, depth + 1);
  }
  return out;
}

function createAgentRunService(options = {}) {
  const queryFn = options.queryFn || database.query;
  const idFactory = options.idFactory || randomUUID;
  const shouldEnsureSchema = options.ensureSchema !== false;
  let schemaPromise = null;

  async function ensureTables() {
    if (!shouldEnsureSchema) return;
    if (schemaPromise) return schemaPromise;
    schemaPromise = queryFn(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id UUID PRIMARY KEY,
        user_phone VARCHAR(50) NOT NULL,
        session_id UUID,
        client_message_id UUID,
        source VARCHAR(30) NOT NULL DEFAULT 'unknown',
        prompt_preview TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'received',
        model VARCHAR(150),
        steps INTEGER NOT NULL DEFAULT 0,
        outcome JSONB,
        error_code VARCHAR(100),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS agent_run_events (
        id BIGSERIAL PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        user_phone VARCHAR(50) NOT NULL,
        event_type VARCHAR(80) NOT NULL,
        step INTEGER,
        tool_name VARCHAR(150),
        summary TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started ON agent_runs(user_phone, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_user_id ON agent_run_events(user_phone, id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id ON agent_run_events(run_id, id);
    `).catch((error) => {
      schemaPromise = null;
      throw error;
    });
    return schemaPromise;
  }

  async function startRun({ userPhone, prompt, source = 'unknown' }) {
    const chatSession = currentChatSession();
    const requestedRunId = chatSession?.runId;
    const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedRunId || '')
      ? requestedRunId
      : idFactory();
    try {
      await ensureTables();
      await queryFn(
        `INSERT INTO agent_runs
           (id, user_phone, source, prompt_preview, status, session_id, client_message_id)
         VALUES ($1, $2, $3, $4, 'received', $5, $6)`,
        [runId, String(userPhone), String(source).slice(0, 30), String(prompt || '').slice(0, 500),
          chatSession?.sessionId || null, chatSession?.clientMessageId || null]
      );
      return { runId, persisted: true };
    } catch (error) {
      logger.warn(`[AgentRun] could not persist run start: ${error.message}`);
      return { runId, persisted: false };
    }
  }

  async function recordEvent({ runId, userPhone, type, step = null, toolName = null, summary = '', payload = {} }) {
    if (!runId || !userPhone || !type) return null;
    try {
      await ensureTables();
      const result = await queryFn(
        `INSERT INTO agent_run_events
           (run_id, user_phone, event_type, step, tool_name, summary, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id, created_at`,
        [runId, String(userPhone), String(type).slice(0, 80), Number.isInteger(step) ? step : null,
          toolName ? String(toolName).slice(0, 150) : null, String(summary || '').slice(0, 500),
          JSON.stringify(redactPayload(payload))]
      );
      return result.rows?.[0] || null;
    } catch (error) {
      logger.warn(`[AgentRun] event ${type} was not persisted: ${error.message}`);
      return null;
    }
  }

  async function finishRun({ runId, status, steps = 0, model = null, outcome = null, errorCode = null }) {
    if (!runId) return false;
    const normalizedStatus = RUN_STATUS_ALIASES[status] || status;
    const safeStatus = VALID_RUN_STATUSES.has(normalizedStatus) ? normalizedStatus : 'failed';
    if (safeStatus === 'failed' && normalizedStatus !== 'failed') {
      // A coerced status is a runtime bug, not a user-action failure. Keep the
      // row visibly diagnosable instead of "failed with no error code".
      errorCode = errorCode || 'invalid_status_token';
      logger.warn(`[AgentRun] run ${runId} reported unknown status '${status}'; stored as failed/invalid_status_token`);
    }
    try {
      await ensureTables();
      await queryFn(
        `UPDATE agent_runs
            SET status = $2::varchar, steps = $3, model = $4, outcome = $5::jsonb,
                error_code = $6, updated_at = NOW(),
                completed_at = CASE WHEN $2::varchar IN ('completed','partial','failed','cancelled') THEN NOW() ELSE completed_at END
          WHERE id = $1`,
        [runId, safeStatus, Math.max(0, Number(steps) || 0), model,
          JSON.stringify(redactPayload(outcome)), errorCode]
      );
      return true;
    } catch (error) {
      logger.warn(`[AgentRun] could not finish run ${runId}: ${error.message}`);
      return false;
    }
  }

  return { ensureTables, startRun, recordEvent, finishRun };
}

module.exports = { createAgentRunService, redactPayload, agentRunService: createAgentRunService() };
