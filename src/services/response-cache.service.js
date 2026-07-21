'use strict';

/**
 * Response Cache — Semantic LLM-response cache (Phase 6 token optimization)
 *
 * Goal: Skip the entire LLM chat call when a user repeats a *cacheable* query.
 * For "hi", "thanks", "help", "what can you do" — semantically similar messages
 * resolve from a per-user in-memory cache in <5ms instead of a 1-2s LLM call.
 *
 * Why per-user, in-memory only
 * ----------------------------
 *   - Per-user: avoids cross-user contamination on personality / context
 *   - In-memory: simpler than Redis vector search, fast (<5ms per lookup),
 *     and the cache is small (30 entries × ~5KB = 150KB per user)
 *   - 10-minute TTL via BoundedMap auto-expiry
 *
 * Why a STRICT whitelist
 * ----------------------
 * For an action-heavy personal assistant, MOST queries are stateful (calendar,
 * tasks, reminders, memory recall) — caching those would silently break things.
 * We only cache queries that match safe patterns:
 *   - Greetings: hi, hello, hey, namaste, yo, hola, sup
 *   - Acknowledgements: thanks, thank you, thx, ty, shukriya
 *   - Help / capabilities: "what can you do", "help", "commands"
 *   - Generic knowledge questions ("what is X", "how does X work")
 *
 * Disabled by default. Activate with OPT_RESPONSE_CACHE=true.
 *
 * Source pattern: GPTCache (arxiv 2411.05276) — 68.8% reduction in API calls
 *   in production. Our hit rate will be lower since Ari is action-heavy
 *   (~10-20% expected), but each hit eliminates a full LLM round-trip.
 */

const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');
const { embedOne, resolveProvider } = require('../utils/embeddings');

// ── Config ───────────────────────────────────────────────────────────────

const ENABLED = process.env.OPT_RESPONSE_CACHE === 'true';
const SIMILARITY_THRESHOLD = parseFloat(process.env.RESPONSE_CACHE_THRESHOLD || '0.92');
const TTL_MS = parseInt(process.env.RESPONSE_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
const MAX_ENTRIES_PER_USER = parseInt(process.env.RESPONSE_CACHE_MAX_PER_USER || '30', 10);
const MIN_LEN = 2;
const MAX_LEN = 200;

// Per-user cache: userPhone -> Array<{ query, embedding, response, ts }>
// BoundedMap auto-expires user buckets after TTL_MS of inactivity.
const _userCaches = new BoundedMap(1000, TTL_MS);

// ── Cacheability rules ───────────────────────────────────────────────────

// CACHEABLE — clear stateless patterns where cached responses are safe to reuse.
const CACHEABLE_PATTERNS = [
  /^(hi|hello|hey|namaste|yo|hola|sup|howdy|good\s+(morning|afternoon|evening))\b[\s!.]*$/i,
  /^(thanks|thank\s+you|thx|ty|shukriya|dhanyavad)\b[\s!.]*$/i,
  /^(ok|okay|cool|nice|great|alright|got\s+it)\b[\s!.]*$/i,
  /^what\s+(can|do)\s+you\s+do\s*\??$/i,
  /^(help|commands|capabilities|features)\s*\??$/i,
  /^how\s+(do|does)\s+(you|i|it)\s+work\s*\??$/i,
  /^who\s+are\s+you\s*\??$/i,
  /^what.?s\s+your\s+name\s*\??$/i,
];

// STATEFUL — never cache, even if other rules say yes.
const STATEFUL_PATTERNS = [
  /\bmy\s+\w+/i,                                          // my tasks, my calendar
  /\b(today|now|tomorrow|yesterday|tonight)\b/i,
  /\b(this|that|it|them)\b\s+\w+/i,                       // anaphora — needs context
  /\b(remind|create|add|delete|cancel|set|update|send|schedule|book|save|log|track|assign)\b/i,
  /\d/,                                                   // any digit — likely time/amount/index
  /[@\+]/,                                                // @mentions or phone numbers
];

/**
 * Decide whether a message is safe to look up / store in the response cache.
 * @param {string} message
 * @returns {boolean}
 */
function isCacheable(message) {
  if (!ENABLED) return false;
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return false;

  // Stateful pattern wins (defensive — avoids false positives)
  if (STATEFUL_PATTERNS.some(re => re.test(trimmed))) return false;

  // Whitelist match
  return CACHEABLE_PATTERNS.some(re => re.test(trimmed));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function _normalize(message) {
  return message.toLowerCase().trim();
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Look up a cached response for a user message.
 * @param {string} userPhone
 * @param {string} message
 * @returns {Promise<null | { response: string, score: number, source: string }>}
 */
async function lookup(userPhone, message) {
  if (!ENABLED) return null;
  if (!userPhone) return null;
  if (!isCacheable(message)) return null;
  if (!resolveProvider()) return null;

  try {
    const cache = _userCaches.get(userPhone);
    if (!cache || cache.length === 0) return null;

    const queryEmbedding = await embedOne(_normalize(message));
    if (!queryEmbedding) return null;

    let best = null;
    let bestScore = -1;
    for (const entry of cache) {
      const score = _cosineSim(queryEmbedding, entry.embedding);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (bestScore >= SIMILARITY_THRESHOLD && best) {
      logger.info(
        `[RespCache] HIT user=${userPhone.slice(0, 5)}* "${message.slice(0, 40)}" score=${bestScore.toFixed(3)}`
      );
      return { response: best.response, score: bestScore, source: 'response_cache' };
    }

    return null;
  } catch (e) {
    logger.warn(`[RespCache] Lookup failed (silent fail to LLM): ${e.message}`);
    return null;
  }
}

/**
 * Store a response in the user's cache.
 * @param {string} userPhone
 * @param {string} message
 * @param {string} response
 * @returns {Promise<void>}
 */
async function store(userPhone, message, response) {
  if (!ENABLED) return;
  if (!userPhone) return;
  if (!isCacheable(message)) return;
  if (!response || typeof response !== 'string') return;
  if (response.length > 5000) return; // avoid caching giant payloads
  if (!resolveProvider()) return;

  try {
    const queryEmbedding = await embedOne(_normalize(message));
    if (!queryEmbedding) return;

    let cache = _userCaches.get(userPhone);
    if (!cache) {
      cache = [];
    }

    // Cap cache size — drop oldest first
    while (cache.length >= MAX_ENTRIES_PER_USER) {
      cache.shift();
    }

    cache.push({
      query: message,
      embedding: queryEmbedding,
      response,
      ts: Date.now(),
    });

    _userCaches.set(userPhone, cache);
  } catch (e) {
    logger.warn(`[RespCache] Store failed: ${e.message}`);
  }
}

/**
 * Stats for monitoring.
 * @returns {object}
 */
function stats() {
  let totalEntries = 0;
  for (const [, entries] of _userCaches.entries()) {
    totalEntries += entries.length;
  }
  return {
    enabled: ENABLED,
    users: _userCaches.size,
    totalEntries,
    threshold: SIMILARITY_THRESHOLD,
    ttlMs: TTL_MS,
    maxPerUser: MAX_ENTRIES_PER_USER,
  };
}

module.exports = { lookup, store, isCacheable, stats };
