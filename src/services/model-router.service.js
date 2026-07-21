'use strict';

/**
 * Model Router
 *
 * Ari talks to three tiers of LLMs:
 *
 *   FAST         — intent classification, single-turn chit-chat, memory recalls
 *                   gpt-4o-mini / gpt-4.1-mini / llama-3.3 / groq
 *                   ~$0.15/M in · ~$0.60/M out · 200ms latency
 *
 *   DEFAULT      — chat with tools, summarization, tool arg extraction
 *                   gpt-4.1 / gpt-4o
 *                   ~$2.50/M in · ~$10/M out · 800ms latency
 *
 *   THINKING     — multi-step planning, contradictions, complex math / legal
 *                   o4-mini / o1-mini / claude-sonnet-4.5-thinking (via OpenRouter)
 *                   ~$3/M in · ~$12/M out + reasoning tokens · 3-8s latency
 *
 * Choosing the right tier saves ~60% cost AND delivers better results where
 * reasoning actually matters.
 *
 * Classification is KEYWORD-BASED (no extra LLM call). Good enough for v1 —
 * upgrade to a learned classifier in future if needed.
 */

const logger = require('../utils/logger');

// ── Tier definitions (override any name via env) ─────────────────────────────
const FAST_MODEL = process.env.MODEL_ROUTER_FAST ||
  process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';

const DEFAULT_MODEL = process.env.MODEL_ROUTER_DEFAULT ||
  process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Thinking-tier model. Only used when explicitly configured AND message triggers
// reasoning keywords. If unset, we fall back to DEFAULT for "thinking" queries.
const THINKING_MODEL = process.env.MODEL_ROUTER_THINKING || '';

// Hard cap on % of queries that get thinking tier (cost guard).
const THINKING_MAX_PERCENT = parseFloat(process.env.MODEL_ROUTER_THINKING_MAX_PERCENT || '5');

// Phase 7: Hard-tool tier — for queries that need multi-tool orchestration
// (chains like "send email AND remind", "after that schedule meeting"). Uses
// a stronger model (e.g. gemini-2.5-pro) with better tool reliability at scale.
// Sits between DEFAULT (single-tool/chat) and THINKING (reasoning-only).
const HARD_TOOL_MODEL = process.env.MODEL_ROUTER_HARD_TOOL || '';
const HARD_TOOL_MAX_PERCENT = parseFloat(process.env.MODEL_ROUTER_HARD_TOOL_MAX_PERCENT || '15');

// ── Keyword patterns per tier ────────────────────────────────────────────────

// FAST tier: short, conversational, no tools needed
const FAST_PATTERNS = [
  /^(hi|hello|hey|namaste|yo|sup|howdy|hola)\b/i,
  /^(thanks?|thx|ty|thank you|shukriya|dhanyavad)\b/i,
  /^(ok(ay)?|yep|yes|no|nope|sure|cool|got it|alright)\b/i,
  /^(bye|goodbye|cya|see ya|alvida)\b/i,
  /^(yaar|bro|dude|mate|buddy)\b/i,
];

// THINKING tier: explicit reasoning asks, legal, multi-constraint planning
const THINKING_PATTERNS = [
  // Legal / compliance
  /\b(legal\s+(advice|opinion)|contract\s+review|compliance|regulation|precedent)/i,
  // Complex planning / multi-constraint
  /\b(plan\s+(my\s+week|a\s+trip|an\s+event|the\s+launch)|optimize|tradeoff)/i,
  /\b(compare|vs\.?|pros\s+and\s+cons|which\s+is\s+better)\b/i,
  // Math / analysis
  /\b(calculate|compute|derive|solve\s+for|analyze|breakdown)\b.*\b(numbers?|data|formula|equation)/i,
  // Long-form reasoning requests
  /\b(think\s+step\s+by\s+step|reason\s+through|explain\s+deeply|detailed\s+analysis)\b/i,
  // Multi-part questions (two or more question marks or multiple "and" conjunctions)
  /\?.*\?/,
];

// HARD-TOOL tier: queries that suggest the LLM will need to chain multiple
// tools (e.g. "remind me at 5pm AND send john an email", "after the meeting
// schedule a follow-up", "create reminder then add to calendar"). The
// stronger model (gemini-2.5-pro) handles 96-tool function calling more
// reliably than Flash on these multi-step flows.
const HARD_TOOL_PATTERNS = [
  // Explicit chaining conjunctions (require an action verb on either side
  // to avoid casual "X and Y" matching)
  /\b(remind|send|schedule|reschedule|create|book|cancel|update|delete|add|log|track|assign|set|notify|move|postpone)\b[^.?!]{0,80}\band\b[^.?!]{0,80}\b(remind|send|schedule|reschedule|create|book|cancel|update|delete|add|log|track|assign|set|notify|move|postpone|then)\b/i,
  // "then" sequencing
  /\b(remind|send|schedule|reschedule|create|book|cancel|update|delete|add|log|track|assign|set|notify|move|postpone)\b[^.?!]{0,80}\bthen\b/i,
  // "after that" / "after the X"
  /\bafter\s+(that|the\s+\w+|i\s+\w+)/i,
  // Comma-separated commands ("remind me at 5, schedule meeting at 6")
  /\b(remind|send|schedule|reschedule|create|book|cancel|update|delete|add|log|track|assign|set|notify|move|postpone)\b[^.?!]{0,40},\s*(remind|send|schedule|reschedule|create|book|cancel|update|delete|add|log|track|assign|set|notify|move|postpone)\b/i,
];

// ── Public API ───────────────────────────────────────────────────────────────

class ModelRouter {
  constructor() {
    this._thinkingCallCount = 0;
    this._hardToolCallCount = 0;
    this._totalCallCount = 0;
    logger.info(
      `[ModelRouter] fast=${FAST_MODEL} default=${DEFAULT_MODEL} hardTool=${HARD_TOOL_MODEL || '(disabled)'} thinking=${THINKING_MODEL || '(disabled)'}`
    );
  }

  /**
   * Pick the right model for a user message.
   *
   * @param {string} message - The user's message text
   * @param {object} [opts]
   * @param {string} [opts.purpose] - One of 'intent' | 'chat' | 'summarize'
   *   If 'intent', always returns FAST. If 'summarize', returns DEFAULT.
   * @param {number} [opts.messageLength] - Override length signal
   * @param {number} [opts.toolCount] - 0 for chit-chat, >0 for tool-likely
   * @returns {{ model: string, tier: 'fast'|'default'|'thinking', reason: string }}
   */
  route(message, opts = {}) {
    this._totalCallCount++;

    // Purpose-based short-circuits
    if (opts.purpose === 'intent') {
      return { model: FAST_MODEL, tier: 'fast', reason: 'intent-classification' };
    }
    if (opts.purpose === 'judge') {
      return { model: FAST_MODEL, tier: 'fast', reason: 'llm-judge' };
    }

    const text = (message || '').toString();
    const len = opts.messageLength ?? text.length;

    // Very short & matches casual pattern → FAST
    if (len < 60 && FAST_PATTERNS.some(re => re.test(text))) {
      return { model: FAST_MODEL, tier: 'fast', reason: 'casual-short' };
    }

    // Reasoning trigger → THINKING (if configured and within budget)
    if (THINKING_MODEL && this._matchesThinking(text)) {
      const thinkingPercent = (this._thinkingCallCount / Math.max(this._totalCallCount, 1)) * 100;
      if (thinkingPercent < THINKING_MAX_PERCENT) {
        this._thinkingCallCount++;
        return { model: THINKING_MODEL, tier: 'thinking', reason: 'reasoning-triggered' };
      }
      // Over budget — fall back to default rather than skipping entirely
      return { model: DEFAULT_MODEL, tier: 'default', reason: 'reasoning-triggered-budget-cap' };
    }

    // Hard-tool trigger → stronger tool-calling model (within budget)
    if (HARD_TOOL_MODEL && this._matchesHardTool(text)) {
      const hardToolPercent = (this._hardToolCallCount / Math.max(this._totalCallCount, 1)) * 100;
      if (hardToolPercent < HARD_TOOL_MAX_PERCENT) {
        this._hardToolCallCount++;
        return { model: HARD_TOOL_MODEL, tier: 'hard-tool', reason: 'multi-tool-chain' };
      }
      return { model: DEFAULT_MODEL, tier: 'default', reason: 'hard-tool-budget-cap' };
    }

    // Everything else → DEFAULT
    return { model: DEFAULT_MODEL, tier: 'default', reason: 'standard-chat' };
  }

  _matchesHardTool(text) {
    if (!text || text.length < 20) return false; // too short for multi-tool work
    return HARD_TOOL_PATTERNS.some(re => re.test(text));
  }

  _matchesThinking(text) {
    if (!text || text.length < 40) return false; // too short to need thinking
    return THINKING_PATTERNS.some(re => re.test(text));
  }

  /**
   * Lightweight stats (for observability dashboards). Values are session-local.
   */
  getStats() {
    return {
      total: this._totalCallCount,
      thinking: this._thinkingCallCount,
      thinkingPercent: this._totalCallCount > 0
        ? +((this._thinkingCallCount / this._totalCallCount) * 100).toFixed(2)
        : 0,
      hardTool: this._hardToolCallCount,
      hardToolPercent: this._totalCallCount > 0
        ? +((this._hardToolCallCount / this._totalCallCount) * 100).toFixed(2)
        : 0,
    };
  }
}

module.exports = new ModelRouter();
