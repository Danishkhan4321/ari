/**
 * Langfuse LLM tracing wrapper.
 *
 * Wraps every LLM call with a trace so you get:
 *  - Per-user cost attribution
 *  - Per-intent latency histograms
 *  - Replay: click any bad answer in Langfuse → reconstruct exact prompt/params
 *  - Prompt versioning (future: move hardcoded prompts to Langfuse-managed)
 *
 * Fails open: if LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are unset, the wrapper
 * becomes a pass-through. No observability data, but the LLM call still runs.
 *
 * Env:
 *   LANGFUSE_PUBLIC_KEY  - required to enable tracing
 *   LANGFUSE_SECRET_KEY  - required to enable tracing
 *   LANGFUSE_HOST        - optional, defaults to cloud (https://cloud.langfuse.com)
 */

const logger = require('./logger');

let langfuseClient = null;
let initAttempted = false;

function getClient() {
  if (initAttempted) return langfuseClient;
  initAttempted = true;

  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;

  if (!pub || !sec) {
    logger.info('Langfuse: disabled (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set)');
    return null;
  }

  try {
    const { Langfuse } = require('langfuse');
    // Accept both env conventions:
    //   LANGFUSE_HOST       (our internal convention)
    //   LANGFUSE_BASE_URL   (Langfuse's official SDK convention)
    const host = process.env.LANGFUSE_HOST
      || process.env.LANGFUSE_BASE_URL
      || 'https://cloud.langfuse.com';
    langfuseClient = new Langfuse({
      publicKey: pub,
      secretKey: sec,
      baseUrl: host,
      // Sample rate — set to 1.0 initially, lower once traffic scales.
      // Langfuse Cloud free tier = 50k observations/month.
      flushAt: 20,
      flushInterval: 5000
    });
    logger.info(`Langfuse: enabled (host: ${host})`);
  } catch (e) {
    logger.warn(`Langfuse init failed (will run without tracing): ${e.message}`);
    langfuseClient = null;
  }

  return langfuseClient;
}

/**
 * Wrap an LLM call with a Langfuse trace.
 *
 * @param {object} traceOpts
 * @param {string} traceOpts.name - e.g. 'openai.chat', 'intent-detection'
 * @param {string} [traceOpts.userId] - user phone for attribution
 * @param {string} [traceOpts.model]
 * @param {any} [traceOpts.input] - messages array or prompt string
 * @param {Record<string, unknown>} [traceOpts.metadata]
 * @param {string[]} [traceOpts.tags] - e.g. ['intent', 'high-traffic']
 * @param {() => Promise<object>} fn - the actual LLM call (returns axios-shaped response)
 * @returns {Promise<object>} the LLM response (unchanged)
 */
async function llmTrace(traceOpts, fn) {
  const client = getClient();

  if (!client) {
    // No-op pass-through.
    return fn();
  }

  const startedAt = Date.now();
  let trace, gen;
  try {
    trace = client.trace({
      name: traceOpts.name || 'llm.call',
      userId: traceOpts.userId,
      tags: traceOpts.tags,
      metadata: traceOpts.metadata
    });
    gen = trace.generation({
      name: traceOpts.name || 'generation',
      model: traceOpts.model,
      input: traceOpts.input,
      metadata: traceOpts.metadata,
      startTime: new Date(startedAt)
    });
  } catch (e) {
    logger.debug(`Langfuse trace start failed: ${e.message}`);
  }

  try {
    const result = await fn();
    try {
      if (gen) {
        // Extract output + usage from OpenAI-style response shape.
        const data = result?.data || result;
        const choice = data?.choices?.[0];
        const output = choice?.message || choice?.text || data?.output || null;
        const usage = data?.usage || result?.usage || null;
        gen.end({
          endTime: new Date(),
          output,
          usage: usage ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens
          } : undefined
        });
      }
    } catch (e) { /* never let observability break the call */ }
    return result;
  } catch (error) {
    try {
      if (gen) {
        gen.end({
          endTime: new Date(),
          level: 'ERROR',
          statusMessage: error.message
        });
      }
    } catch (e) { /* noop */ }
    throw error;
  }
}

/**
 * Score a trace (thumbs up/down from user) — wire to feedback buttons.
 * @param {string} traceId
 * @param {'positive'|'negative'|number} value
 * @param {string} [comment]
 */
function score(traceId, value, comment) {
  const client = getClient();
  if (!client || !traceId) return;
  try {
    client.score({
      traceId,
      name: 'user-feedback',
      value: typeof value === 'number' ? value : (value === 'positive' ? 1 : 0),
      comment
    });
  } catch (e) { /* noop */ }
}

/**
 * Flush pending observations — call from graceful shutdown so data isn't lost.
 */
async function flush() {
  const client = getClient();
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (e) {
    logger.debug(`Langfuse flush failed: ${e.message}`);
  }
}

module.exports = { llmTrace, score, flush };
