/**
 * Circuit breakers for external services — opossum-backed.
 *
 * Problem solved: when an external service (OpenAI, Gmail, Tavily, etc.) is slow
 * or flapping, every request independently burns 5-15 seconds hitting retries
 * via utils/retry.js. 100 concurrent messages = 100 independent stalls.
 *
 * Pattern: wrap the axios/SDK call in a breaker. After N failures in the rolling
 * window, the breaker OPENS and subsequent calls fall through to the fallback
 * immediately (~5ms vs ~7000ms). After resetTimeout the breaker HALF-OPENs and
 * tests recovery with one call.
 *
 * Usage:
 *   const { openaiBreaker } = require('./utils/circuit-breakers');
 *   const result = await openaiBreaker.fire(args);
 *
 * Fallbacks return a typed `{ degraded: true, ... }` shape so callers can detect
 * and handle graceful degradation.
 */

const CircuitBreaker = require('opossum');
const logger = require('./logger');

// Track per-breaker state for /health reporting.
const breakers = {};

function createBreaker(name, fn, options = {}) {
  // Test/benchmark bypass: promptfoo runs hit the breaker hard and can trip it
  // on transient Gemini/Bedrock hiccups, poisoning the rest of the eval. Setting
  // DISABLE_CIRCUIT_BREAKERS=1 returns a pass-through shim with the same API
  // surface (fire, on, fallback) so callers work unchanged but nothing trips.
  if (process.env.DISABLE_CIRCUIT_BREAKERS === '1') {
    const passthrough = {
      fire: async (...args) => fn(...args),
      fallback: () => passthrough,
      on: () => passthrough,
      opened: false,
      halfOpen: false,
      closed: true,
      name
    };
    breakers[name] = passthrough;
    return passthrough;
  }

  const breaker = new CircuitBreaker(fn, {
    timeout: options.timeout || 30000,
    errorThresholdPercentage: options.errorThresholdPercentage || 50,
    resetTimeout: options.resetTimeout || 30000,
    rollingCountTimeout: options.rollingCountTimeout || 60000,
    rollingCountBuckets: options.rollingCountBuckets || 10,
    volumeThreshold: options.volumeThreshold || 5, // Don't trip on first couple of failures
    name
  });

  if (options.fallback) breaker.fallback(options.fallback);

  breaker.on('open', () => {
    logger.warn(`[CircuitBreaker] ${name} OPEN — failing fast`);
    try { require('./sentry').Sentry?.captureMessage(`Circuit breaker ${name} opened`, { level: 'warning' }); } catch (e) { /* noop */ }
  });
  breaker.on('halfOpen', () => {
    logger.info(`[CircuitBreaker] ${name} HALF-OPEN — testing recovery`);
  });
  breaker.on('close', () => {
    logger.info(`[CircuitBreaker] ${name} CLOSED — healthy`);
  });

  breakers[name] = breaker;
  return breaker;
}

// ── OpenAI chat/completion calls ──────────────────────────────────────────
// Fallback: brief apology message. Callers can detect `degraded: true` and skip
// expensive follow-up calls.
const openaiBreaker = createBreaker(
  'openai',
  async (fn) => fn(),
  {
    timeout: 45000,              // OpenAI can be slow on complex tool calls
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
    fallback: () => ({
      degraded: true,
      reason: 'openai_unavailable',
      text: 'AI providers are temporarily busy. Please try your request again shortly.'
    })
  }
);

// ── OpenAI embeddings (memory vector search) ──────────────────────────────
const openaiEmbeddingsBreaker = createBreaker(
  'openai-embeddings',
  async (fn) => fn(),
  {
    timeout: 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
    fallback: () => ({ degraded: true, reason: 'embeddings_unavailable', vector: null })
  }
);

// ── Gmail API ─────────────────────────────────────────────────────────────
const gmailBreaker = createBreaker(
  'gmail',
  async (fn) => fn(),
  {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 60000,
    volumeThreshold: 3,
    fallback: () => ({ degraded: true, reason: 'gmail_unavailable' })
  }
);

// ── Google Calendar API ───────────────────────────────────────────────────
const calendarBreaker = createBreaker(
  'calendar',
  async (fn) => fn(),
  {
    timeout: 20000,
    errorThresholdPercentage: 50,
    resetTimeout: 60000,
    volumeThreshold: 3,
    fallback: () => ({ degraded: true, reason: 'calendar_unavailable', events: [] })
  }
);

// ── Tavily web search ─────────────────────────────────────────────────────
const tavilyBreaker = createBreaker(
  'tavily',
  async (fn) => fn(),
  {
    timeout: 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 3,
    fallback: () => ({ degraded: true, reason: 'search_unavailable', results: [] })
  }
);

// ── AssemblyAI transcription ──────────────────────────────────────────────
const assemblyAIBreaker = createBreaker(
  'assemblyai',
  async (fn) => fn(),
  {
    timeout: 600000, // Transcription is genuinely slow — 10 min cap
    errorThresholdPercentage: 50,
    resetTimeout: 120000,
    volumeThreshold: 2,
    fallback: () => ({ degraded: true, reason: 'transcription_unavailable' })
  }
);

// ── Anthropic Direct (H3-N) ────────────────────────────────────────────────
// The Claude family routed via the official Anthropic SDK (not Bedrock).
// Until May 19 2026 this path had no breaker, so an Anthropic 503 outage
// stalled every Claude call for 30-45s before erroring. With this in
// place, after N failures we fail fast and the LLM fallback chain can
// hop to another provider.
const anthropicBreaker = createBreaker(
  'anthropic',
  async (fn) => fn(),
  {
    timeout: 45000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
    fallback: () => ({
      degraded: true,
      reason: 'anthropic_unavailable',
      text: 'AI providers are temporarily busy. Please try your request again shortly.'
    })
  }
);

// ── Bedrock LLM (H3-N) ─────────────────────────────────────────────────────
// AWS Bedrock-hosted models (Claude, Nova, Mistral). Same gap as Anthropic
// Direct — outages used to surface as a long stall.
const bedrockBreaker = createBreaker(
  'bedrock',
  async (fn) => fn(),
  {
    timeout: 45000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
    fallback: () => ({
      degraded: true,
      reason: 'bedrock_unavailable',
      text: 'AI providers are temporarily busy. Please try your request again shortly.'
    })
  }
);

// ── Supabase Storage (S3) ─────────────────────────────────────────────────
const storageBreaker = createBreaker(
  'storage',
  async (fn) => fn(),
  {
    timeout: 30000,
    errorThresholdPercentage: 60,
    resetTimeout: 60000,
    volumeThreshold: 5,
    fallback: () => ({ degraded: true, reason: 'storage_unavailable' })
  }
);

/**
 * Returns a map of breaker states for /health endpoint.
 */
function getHealth() {
  const out = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    const stats = breaker.stats || breaker.status?.stats || {};
    out[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: {
        fires: stats.fires || 0,
        successes: stats.successes || 0,
        failures: stats.failures || 0,
        rejects: stats.rejects || 0,
        timeouts: stats.timeouts || 0,
        fallbacks: stats.fallbacks || 0
      }
    };
  }
  return out;
}

/**
 * Generic helper: wrap any async function with the appropriate breaker.
 * The breaker's `fire` accepts a function and calls it — we use this thunk
 * pattern so we don't have to create one breaker per call signature.
 */
function fire(breaker, fn) {
  return breaker.fire(fn);
}

module.exports = {
  openaiBreaker,
  openaiEmbeddingsBreaker,
  gmailBreaker,
  calendarBreaker,
  tavilyBreaker,
  assemblyAIBreaker,
  storageBreaker,
  anthropicBreaker,
  bedrockBreaker,
  getHealth,
  fire
};
