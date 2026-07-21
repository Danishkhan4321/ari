'use strict';

/**
 * Intent Fast Path — Embedding-based pre-classifier (Phase 3 token optimization)
 *
 * Goal: Skip the LLM intent-detection call entirely for canonical, high-confidence
 * WhatsApp queries like "show my tasks", "dashboard", "my reminders". For these
 * patterns, an embedding similarity match (~50ms) replaces a ~$0.002 LLM call.
 *
 * How it works:
 *   1. On first use, embed all CANONICAL_INTENTS phrases via text-embedding-3-small
 *      ($0.02/1M tokens — pennies for ~50 phrases). Cached for the process lifetime.
 *   2. On every detectIntent() call, embed the user's message (with 5-min cache).
 *   3. Cosine-similarity vs every canonical intent. If top match >= threshold,
 *      return that tool routing directly. Otherwise return null → fall through
 *      to the existing LLM intent path.
 *
 * Safety:
 *   - Disabled by default. Activate with OPT_EMBEDDING_FAST_PATH=true.
 *   - Confidence threshold default 0.85 — tune via FASTPATH_CONFIDENCE.
 *   - On any error, returns null (falls through to LLM). Never breaks routing.
 *   - Long messages (>80 chars) skip fast path — they're more likely complex.
 *
 * Expected savings: 40-60% of intent calls eliminated on common WhatsApp traffic
 * per RAG-MCP / embedding-classification literature (arxiv 2505.03275).
 */

const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');
const { embed: embedFn, resolveProvider } = require('../utils/embeddings');

const ENABLED = process.env.OPT_EMBEDDING_FAST_PATH === 'true';
const CONFIDENCE_THRESHOLD = parseFloat(process.env.FASTPATH_CONFIDENCE || '0.85');
const MAX_MESSAGE_LEN = parseInt(process.env.FASTPATH_MAX_MSG_LEN || '80', 10);

// Canonical intents — high-confidence WhatsApp patterns we know SHOULD route to a
// specific tool. Keep this list TIGHT: every entry here is a guarantee that we
// will skip LLM classification on similar messages. Bias toward false-negatives
// (let LLM decide if unsure) over false-positives (wrong tool fired).
//
// Each entry: { phrase: 'canonical text', toolName: 'tool_name', params?: {...} }
// `phrase` should be the natural way the user types it. Synonyms get separate
// entries so all variants get embedded and matched.
const CANONICAL_INTENTS = [
  // ── Tasks ─────────────────────────────────────────────────────────
  { phrase: 'show my tasks',                toolName: 'manage_tasks', params: { action: 'list' } },
  { phrase: 'list my tasks',                toolName: 'manage_tasks', params: { action: 'list' } },
  { phrase: 'my tasks',                     toolName: 'manage_tasks', params: { action: 'list' } },
  { phrase: 'tasks list',                   toolName: 'manage_tasks', params: { action: 'list' } },
  { phrase: 'mere tasks dikhao',            toolName: 'manage_tasks', params: { action: 'list' } },
  { phrase: 'tasks assigned to me',         toolName: 'manage_tasks', params: { action: 'list_assigned_to_me' } },
  { phrase: 'show tasks assigned to me',    toolName: 'manage_tasks', params: { action: 'list_assigned_to_me' } },
  { phrase: 'tasks i assigned',             toolName: 'manage_tasks', params: { action: 'list_assigned_by_me' } },
  { phrase: 'tasks i delegated',            toolName: 'manage_tasks', params: { action: 'list_assigned_by_me' } },
  { phrase: 'show tasks i gave to others',  toolName: 'manage_tasks', params: { action: 'list_assigned_by_me' } },

  // ── Reminders ─────────────────────────────────────────────────────
  // (Jul 2026 fix: these pointed at 'list_reminders' / 'list_calendar_events'
  // / 'list_memories' / 'clear_history' — tool names that DON'T EXIST in
  // tool-definitions.js. With the fast path enabled, "show my reminders"
  // routed to an unknown intent type and fell into generic fallbacks.)
  { phrase: 'show my reminders',            toolName: 'view_reminders' },
  { phrase: 'my reminders',                 toolName: 'view_reminders' },
  { phrase: 'list reminders',               toolName: 'view_reminders' },
  { phrase: 'all my reminders',             toolName: 'view_reminders' },

  // ── Calendar / Briefing ───────────────────────────────────────────
  { phrase: 'show my calendar',             toolName: 'view_calendar' },
  { phrase: 'my calendar',                  toolName: 'view_calendar' },
  { phrase: 'my meetings',                  toolName: 'view_calendar' },
  { phrase: 'show my meetings today',       toolName: 'view_calendar' },
  { phrase: 'whats on my schedule today',   toolName: 'daily_briefing' },
  { phrase: 'whats on my plate',            toolName: 'daily_briefing' },
  { phrase: 'daily briefing',               toolName: 'daily_briefing' },
  { phrase: 'brief me',                     toolName: 'daily_briefing' },
  { phrase: 'whats on for today',           toolName: 'daily_briefing' },

  // ── Dashboard ─────────────────────────────────────────────────────
  { phrase: 'dashboard',                    toolName: 'view_dashboard' },
  { phrase: 'show dashboard',               toolName: 'view_dashboard' },
  { phrase: 'my dashboard',                 toolName: 'view_dashboard' },
  { phrase: 'my stats',                     toolName: 'view_dashboard' },
  { phrase: 'overview',                     toolName: 'view_dashboard' },

  // ── Notes ─────────────────────────────────────────────────────────
  { phrase: 'show my notes',                toolName: 'manage_notes',    params: { action: 'list' } },
  { phrase: 'my notes',                     toolName: 'manage_notes',    params: { action: 'list' } },
  { phrase: 'list my notes',                toolName: 'manage_notes',    params: { action: 'list' } },

  // ── Contacts ──────────────────────────────────────────────────────
  { phrase: 'show my contacts',             toolName: 'manage_contacts', params: { action: 'list' } },
  { phrase: 'my contacts',                  toolName: 'manage_contacts', params: { action: 'list' } },
  { phrase: 'list contacts',                toolName: 'manage_contacts', params: { action: 'list' } },

  // ── Memory ────────────────────────────────────────────────────────
  { phrase: 'what do you remember about me', toolName: 'recall_memory' },
  { phrase: 'show my memories',             toolName: 'recall_memory' },
  { phrase: 'my saved facts',               toolName: 'recall_memory' },

  // ── Conversation actions ──────────────────────────────────────────
  { phrase: 'clear chat',                   toolName: 'clear_chat_history' },
  { phrase: 'clear my history',             toolName: 'clear_chat_history' },
  { phrase: 'delete chat history',          toolName: 'clear_chat_history' },
];

// Module-level state — populated lazily on first call
let _intentEmbeddings = null;
let _initPromise = null;
const _messageCache = new BoundedMap(1000, 5 * 60 * 1000); // 5-min msg embedding cache

// ── Helpers ──────────────────────────────────────────────────────────────

async function _embed(input) {
  // input may be string OR array of strings
  // Provider is auto-resolved (Gemini preferred, OpenAI fallback)
  return embedFn(input, { timeout: 5000 });
}

async function _buildIndex() {
  if (_intentEmbeddings) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // Drift guard (Jul 2026): only index entries whose toolName actually
    // exists in tool-definitions. A stale name here silently routed common
    // queries ("show my reminders") to an unknown intent type in production.
    // Skipped entries fall through to the LLM path — degraded, not broken.
    const { getToolDefinitions } = require('./tool-definitions');
    const realTools = new Set(getToolDefinitions().map(t => t.function?.name).filter(Boolean));
    const valid = CANONICAL_INTENTS.filter(i => {
      if (realTools.has(i.toolName)) return true;
      logger.warn(`[FastPath] Skipping canonical intent with unknown tool "${i.toolName}" (phrase: "${i.phrase}")`);
      return false;
    });

    const phrases = valid.map(i => i.phrase);
    const data = await _embed(phrases);
    _intentEmbeddings = data.map((d, i) => ({
      ...valid[i],
      embedding: d.embedding,
    }));
    logger.info(`[FastPath] Built embedding index: ${_intentEmbeddings.length} canonical intents`);
  })().catch(e => {
    logger.error(`[FastPath] Index build failed: ${e.message}`);
    _initPromise = null; // allow retry on next call
    throw e;
  });
  return _initPromise;
}

function _cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Classify a user message via embedding similarity vs canonical intents.
 *
 * @param {string} message - raw user message
 * @returns {Promise<null | { toolName, params, confidence, source }>}
 *   Returns null when disabled, on error, or when no match clears the threshold.
 *   On hit, the caller should treat this as a successful intent classification
 *   and skip the LLM call entirely.
 */
async function classify(message) {
  if (!ENABLED) return null;
  if (!resolveProvider()) return null; // require some embedding key (Gemini or OpenAI)
  if (!message || typeof message !== 'string') return null;

  const lower = message.toLowerCase().trim();
  if (!lower) return null;
  if (lower.length > MAX_MESSAGE_LEN) return null; // long msgs likely complex — let LLM handle

  try {
    if (!_intentEmbeddings) await _buildIndex();

    let messageEmbedding = _messageCache.get(lower);
    if (!messageEmbedding) {
      const data = await _embed(lower);
      messageEmbedding = data[0].embedding;
      _messageCache.set(lower, messageEmbedding);
    }

    let bestMatch = null;
    let bestScore = -1;
    for (const intent of _intentEmbeddings) {
      const score = _cosineSim(messageEmbedding, intent.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = intent;
      }
    }

    if (bestScore >= CONFIDENCE_THRESHOLD && bestMatch) {
      logger.info(`[FastPath] HIT "${lower}" -> ${bestMatch.toolName} (score=${bestScore.toFixed(3)})`);
      return {
        toolName: bestMatch.toolName,
        params: bestMatch.params || {},
        confidence: bestScore,
        source: 'fastpath_embedding',
      };
    }

    logger.debug(`[FastPath] MISS "${lower}" (best=${bestScore.toFixed(3)} < ${CONFIDENCE_THRESHOLD})`);
    return null;
  } catch (e) {
    // Never throw — always fall through to the LLM path.
    logger.warn(`[FastPath] Classify failed (falling through to LLM): ${e.message}`);
    return null;
  }
}

/**
 * Stats for monitoring / dashboards.
 */
function stats() {
  return {
    enabled: ENABLED,
    indexedIntents: _intentEmbeddings ? _intentEmbeddings.length : 0,
    messageCacheSize: _messageCache.size,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    embeddingProvider: resolveProvider(),
  };
}

module.exports = {
  classify,
  stats,
  // Exported for tests / warmup hooks:
  _buildIndex,
  CANONICAL_INTENTS,
};
