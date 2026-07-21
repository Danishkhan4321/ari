'use strict';

/**
 * Tool Retriever — RAG-MCP semantic tool selection (Phase 4 token optimization)
 *
 * Why this exists
 * ---------------
 * Ari has 96 function-calling tool definitions (~13K tokens). Sending all 96
 * on every intent call is wasteful AND hurts accuracy: research shows tool-call
 * accuracy *degrades* once the candidate pool exceeds ~100 tools.
 *
 * RAG-MCP reverses both problems:
 *   - Embed all 96 tool descriptions once on startup.
 *   - For each user message, semantically retrieve the top-K=8 most relevant tools.
 *   - Always include ESSENTIAL_TOOLS (web_search, help, dashboard, memory) as
 *     safety nets so cross-category asks still have escape hatches.
 *   - Send only those ~13 tools to the LLM. ~86% prompt reduction on tool defs.
 *
 * Source: arxiv 2505.03275 — RAG-MCP measured 50% prompt reduction AND
 * tool-selection accuracy improving from 13.62% → 43.13% (3.2x) at ~100 tools.
 *
 * Compared to existing keyword-classifier (classifyCategoryFromKeywords)
 * ---------------------------------------------------------------------
 * The existing regex-based classifier works on English keywords. This semantic
 * retriever:
 *   - Works on Hindi, Hinglish, Arabic, Spanish — any language the embedding
 *     model knows (text-embedding-3-small handles 100+ languages).
 *   - Catches paraphrases ("schedule a thing" → calendar tools) that regex misses.
 *   - Can be tuned by raising/lowering K instead of editing regexes.
 *
 * Safety
 * ------
 *   - Disabled by default. Activate with OPT_RAG_MCP_ENABLED=true.
 *   - On any error, returns null → caller falls back to existing logic
 *     (keyword subsetting if TOOL_SUBSETTING_ENABLED, else full 96-tool set).
 *   - First call lazily builds the index (~$0.0002, ~600ms one-time).
 *   - Message embeddings cached 5min (no re-embed on retries).
 *
 * Expected impact at 1 user × 100 msgs/day
 *   - Intent input cut by ~10K tokens (96 tools → ~13 tools sent to LLM)
 *   - Combined with prompt caching: ~3K calls × $0.30/M × 10K = $9/mo saved
 *   - Tool-call accuracy improves on multilingual / paraphrased queries.
 */

const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');
const { embed: embedFn, resolveProvider } = require('../utils/embeddings');
const fireworksRerank = require('../utils/fireworks-rerank');

// ── Config (env-driven) ──────────────────────────────────────────────────

const ENABLED = process.env.OPT_RAG_MCP_ENABLED === 'true';
const TOP_K = parseInt(process.env.RAG_MCP_TOP_K || '8', 10);
const RERANK_ENABLED = process.env.RAG_MCP_RERANK_ENABLED !== 'false';
const DEBUG = process.env.RAG_MCP_DEBUG === 'true';

// ── Module state (lazy) ──────────────────────────────────────────────────

/** @type {Array<{ tool: object, embedding: number[] }> | null} */
let _toolEmbeddings = null;
/** @type {Promise<void> | null} */
let _initPromise = null;
const _messageCache = new BoundedMap(1000, 5 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Embed text(s) via OpenAI. Accepts string or string[].
 * @param {string|string[]} input
 * @returns {Promise<Array<{ embedding: number[] }>>}
 */
async function _embed(input) {
  // Provider auto-resolved (Gemini preferred, OpenAI fallback)
  return embedFn(input, { timeout: 15000 });
}

/**
 * Convert an OpenAI tool definition to embedding-friendly text.
 * Includes name + description (parameters skipped — too noisy for retrieval).
 * @param {object} tool - { type, function: { name, description, parameters } }
 * @returns {string}
 */
function _toolToText(tool) {
  const name = tool?.function?.name || '';
  const desc = tool?.function?.description || '';
  return `${name}: ${desc}`;
}

/**
 * Cosine similarity between two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function _cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Lazily embed all tool definitions on first use. Idempotent.
 * @returns {Promise<void>}
 */
async function _buildIndex() {
  if (_toolEmbeddings) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { getToolDefinitions } = require('./tool-definitions');
    const allTools = getToolDefinitions();
    if (!Array.isArray(allTools) || allTools.length === 0) {
      throw new Error('getToolDefinitions returned empty');
    }
    const texts = allTools.map(_toolToText);
    const startedAt = Date.now();
    const data = await _embed(texts);
    _toolEmbeddings = data.map((d, i) => ({
      tool: allTools[i],
      embedding: d.embedding,
    }));
    logger.info(`[RAG-MCP] Indexed ${_toolEmbeddings.length} tools in ${Date.now() - startedAt}ms`);
  })().catch(e => {
    logger.error(`[RAG-MCP] Index build failed: ${e.message}`);
    _initPromise = null; // allow retry on next call
    throw e;
  });
  return _initPromise;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Retrieve the top-K semantically-relevant tools for a user message,
 * always padded with ESSENTIAL_TOOLS as safety nets.
 *
 * @param {string} message - raw user message
 * @param {object} [options]
 * @param {number} [options.topK] - override default TOP_K
 * @returns {Promise<null | { tools: object[], topScore: number, retrievedCount: number, sourceCount: number }>}
 *   Returns null when disabled, on error, or for trivially-short messages.
 *   On hit, returns a SUBSET of tools to pass to the LLM instead of all 96.
 */
async function retrieve(message, options = {}) {
  if (!ENABLED) return null;
  if (!resolveProvider()) return null; // require some embedding key
  if (!message || typeof message !== 'string') return null;

  const lower = message.toLowerCase().trim();
  if (!lower) return null;
  if (lower.length > 1000) return null; // truncate long messages elsewhere

  try {
    if (!_toolEmbeddings) await _buildIndex();

    // Embed user message (with cache)
    let messageEmbedding = _messageCache.get(lower);
    if (!messageEmbedding) {
      const data = await _embed(lower);
      messageEmbedding = data[0].embedding;
      _messageCache.set(lower, messageEmbedding);
    }

    // Score every tool
    const scored = _toolEmbeddings.map(({ tool, embedding }) => ({
      tool,
      score: _cosineSim(messageEmbedding, embedding),
    }));
    scored.sort((a, b) => b.score - a.score);

    const k = Math.max(1, Math.min(options.topK || TOP_K, scored.length));
    let topK = scored.slice(0, k);

    if (RERANK_ENABLED && fireworksRerank.isAvailable()) {
      const candidateCount = Math.min(scored.length, Math.max(k * 3, k));
      const candidates = scored.slice(0, candidateCount);
      const reranked = await fireworksRerank.rerank(
        lower,
        candidates.map(s => _toolToText(s.tool)),
        { topN: k, timeout: 8000 }
      );

      if (Array.isArray(reranked) && reranked.length > 0) {
        const rerankedTopK = reranked
          .map(r => {
            const candidate = candidates[r.index];
            return candidate ? { ...candidate, score: r.score, embeddingScore: candidate.score } : null;
          })
          .filter(Boolean)
          .slice(0, k);
        if (rerankedTopK.length > 0) topK = rerankedTopK;
      }
    }

    const topToolNames = new Set(topK.map(s => s.tool.function.name));

    // Always include ESSENTIAL_TOOLS regardless of similarity
    const { ESSENTIAL_TOOLS } = require('./tool-definitions');
    const essentialEntries = scored.filter(
      s => ESSENTIAL_TOOLS.includes(s.tool.function.name) && !topToolNames.has(s.tool.function.name)
    );

    const selected = [...topK, ...essentialEntries];
    const tools = selected.map(s => s.tool);

    logger.info(
      `[RAG-MCP] Retrieved ${tools.length} tools (topK=${topK.length}, essentials=${essentialEntries.length}) for "${lower.slice(0, 60)}" topScore=${topK[0].score.toFixed(3)}`
    );
    if (DEBUG) {
      logger.debug(
        `[RAG-MCP] Top picks: ${topK.map(s => `${s.tool.function.name}=${s.score.toFixed(2)}`).join(', ')}`
      );
    }

    return {
      tools,
      topScore: topK[0]?.score || 0,
      retrievedCount: tools.length,
      sourceCount: scored.length,
    };
  } catch (e) {
    logger.warn(`[RAG-MCP] Retrieval failed (falling through to full tool set): ${e.message}`);
    return null;
  }
}

/**
 * Stats for monitoring / dashboards.
 * @returns {object}
 */
function stats() {
  return {
    enabled: ENABLED,
    indexedTools: _toolEmbeddings ? _toolEmbeddings.length : 0,
      messageCacheSize: _messageCache.size,
      topK: TOP_K,
      embeddingProvider: resolveProvider(),
      rerankerProvider: fireworksRerank.isAvailable() ? 'fireworks' : null,
    };
}

module.exports = {
  retrieve,
  stats,
  // Exported for tests / warmup hooks:
  _buildIndex,
};
