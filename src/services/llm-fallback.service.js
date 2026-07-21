'use strict';

/**
 * LLM Fallback Chain — multi-provider failover for chat completions.
 *
 * Wraps `llm-provider.chatCompletion` so that when the primary model fails
 * with a retryable error (rate limit / server error / network), the call is
 * retried on a different provider before surfacing the error to the user.
 *
 * Default chain (configurable via env LLM_FALLBACK_CHAIN):
 *   primary (whatever was passed in body.model)
 *   → claude-haiku-4.5  (Anthropic Direct, different infra)
 *   → llama-3.3-70b-versatile (Groq, different infra again)
 *
 * Why this is a separate service
 * ------------------------------
 * `llm-provider.chatCompletion` is called from ~35 sites. Adding fallback to
 * every call site directly would be invasive. This service exposes a drop-in
 * replacement that callers OPT INTO at strategic points (chat path, intent
 * detection) — keeps the change minimal-surface.
 *
 * Disabled by default. Activate with OPT_FALLBACK_CHAIN_ENABLED=true.
 *
 * Errors that DO trigger fallback:
 *   - Network errors (no response received)
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (server errors / timeouts)
 *
 * Errors that DO NOT trigger fallback (config bugs, not transient):
 *   - HTTP 400 (bad request — wrong params)
 *   - HTTP 401 (auth)
 *   - HTTP 403 (permission)
 *   - HTTP 404 (model not found)
 */

const logger = require('../utils/logger');
const llmProvider = require('./llm-provider');

const ENABLED = process.env.OPT_FALLBACK_CHAIN_ENABLED === 'true';

const DEFAULT_CHAIN = 'claude-haiku-4.5,llama-3.3-70b-versatile';

function getChain() {
  return (process.env.LLM_FALLBACK_CHAIN || DEFAULT_CHAIN)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Decide whether an error should trigger failover to the next provider.
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  // No response at all — network error, timeout, DNS, etc.
  if (!err || !err.response) return true;
  const status = err.response.status;
  if (status === 429) return true;            // rate limit
  if (status >= 500 && status <= 599) return true; // server errors
  return false;
}

/**
 * Run chatCompletion with multi-provider fallback. Same signature as
 * llm-provider.chatCompletion — drop-in replacement when fallback desired.
 *
 * @param {object} body - chat completion request body (must include `model`)
 * @param {object} [opts]
 * @returns {Promise<object>} axios response
 */
async function chatCompletion(body, opts = {}) {
  // If fallback disabled or caller opted out (e.g. recursive call), pass through.
  if (!ENABLED || opts._skipFallback) {
    return llmProvider.chatCompletion(body, opts);
  }

  const primary = body.model;
  if (!primary) {
    return llmProvider.chatCompletion(body, opts);
  }

  // Build the attempt list: primary, then chain entries (deduped, primary excluded)
  const chain = getChain().filter(m => m !== primary);
  const attempts = [primary, ...chain];

  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    try {
      const result = await llmProvider.chatCompletion(
        { ...body, model },
        { ...opts, _skipFallback: true } // prevent recursion
      );
      if (i > 0) {
        logger.warn(
          `[LLM-Fallback] Recovered on attempt ${i + 1}/${attempts.length} via ${model} (primary ${primary} failed)`
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      const status = err.response?.status || 'network';
      if (!isRetryableError(err)) {
        logger.warn(
          `[LLM-Fallback] Permanent error on ${model} (status=${status}) — aborting chain`
        );
        throw err; // permanent error: no point trying others (likely config bug)
      }
      logger.warn(
        `[LLM-Fallback] Attempt ${i + 1}/${attempts.length} failed on ${model}: status=${status}, retrying next...`
      );
    }
  }

  // All attempts exhausted — surface the last error
  logger.error(
    `[LLM-Fallback] All ${attempts.length} providers failed (chain: ${attempts.join(' → ')})`
  );
  throw lastError;
}

/**
 * Convenience: explicitly request fallback even when env flag is off.
 * Use sparingly for critical paths.
 */
async function chatCompletionForce(body, opts = {}) {
  return chatCompletion(body, { ...opts, _forceFallback: true });
}

function stats() {
  return {
    enabled: ENABLED,
    chain: getChain(),
  };
}

module.exports = { chatCompletion, chatCompletionForce, stats };
