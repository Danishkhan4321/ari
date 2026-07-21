/**
 * Anthropic Cache Warmer
 * ──────────────────────
 *
 * Anthropic's prompt cache has a 5-minute TTL. Every time it expires and the
 * NEXT user message arrives, that message pays the cache-write premium
 * ($1.25/M instead of $0.10/M for cached reads). At low-to-medium traffic,
 * cache writes are 50%+ of the Anthropic bill (we measured this in the
 * 2026-04-25 cost analysis).
 *
 * This job fires a tiny "ping" call every 4 minutes (under the 5-min TTL)
 * to keep the system-prompt + tool-definitions cache hot.
 *
 * SMART MODE: only fires when there has been user activity in the last 15
 * minutes. If the bot has been idle for an hour, the warmer skips itself —
 * so we don't burn $$$ when nobody is using the bot.
 *
 * Per-warm cost: ~$0.0006 (mostly cached input + ~5 output tokens).
 * Net savings vs cache-cold calls scales with traffic:
 *   - 60 msgs/mo (current alpha): ~$0.20/mo saved
 *   - 3K msgs/mo: ~$5/mo saved
 *   - 30K msgs/mo: ~$50/mo saved
 *
 * Disabled via: CACHE_WARMER_ENABLED=false (default = enabled if Anthropic key set)
 */

const cron = require('node-cron');
const logger = require('../utils/logger');

class AnthropicCacheWarmerJob {
  constructor() {
    this.isRunning = false;
    this.warmsToday = 0;
    this.warmsSkippedIdle = 0;
    this.warmsSkippedRecent = 0; // skipped because real traffic keeps cache hot
    this.warmsFailed = 0;
    this.lastWarmAt = null;
    this.lastSkipReason = null;
  }

  start() {
    if (process.env.CACHE_WARMER_ENABLED === 'false') {
      logger.info('[CacheWarmer] disabled via CACHE_WARMER_ENABLED=false');
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.info('[CacheWarmer] disabled: no ANTHROPIC_API_KEY (warmer only useful with Anthropic Direct)');
      return;
    }

    // Fire every 4 minutes. The 5-min cache TTL means we have a 1-min buffer
    // for clock skew / cron jitter.
    // Wrap in .catch so an unhandled rejection (e.g. transient Anthropic
    // 5xx) can't leak as an unhandledRejection event and crash the process.
    cron.schedule('*/4 * * * *', () => {
      this.warm().catch((err) => {
        logger.error(`[CacheWarmer] Unhandled error in cron tick: ${err.message}`);
      });
    });

    // First warm 60s after startup (lets DB connect, tools load, etc.)
    setTimeout(() => {
      this.warm().catch((err) => {
        logger.error(`[CacheWarmer] Unhandled error in initial warm: ${err.message}`);
      });
    }, 60_000);

    logger.info('[CacheWarmer] started — checking every 4min, warms only if recent traffic');
  }

  /**
   * Fire one warm-up call to Claude Haiku 4.5 with the same system+tools
   * shape that detectIntent uses. Skips entirely if there's been no recent
   * user activity.
   */
  async warm() {
    if (this.isRunning) return; // mutex
    this.isRunning = true;

    try {
      // ADAPTIVE WARMING — fire only when cache is about to expire AND
      // there's been recent-enough activity that user is likely coming back.
      //   - 0-3.5 min since last user msg → SKIP (cache still hot from real call)
      //   - 3.5-60 min since last user msg → WARM (sweet spot)
      //   - 60+ min since last user msg → SKIP (bot idle, save $$$)
      // This auto-tunes to traffic: heavy traffic = warmer rarely fires (cache
      // already hot), light traffic = fires often, idle = silent.
      const minutesAgo = await this._getMinutesSinceLastUserMessage();
      const MIN_GAP = parseFloat(process.env.CACHE_WARMER_MIN_GAP_MIN || '3.5');
      const MAX_GAP = parseFloat(process.env.CACHE_WARMER_MAX_GAP_MIN || '60');

      if (minutesAgo === null) {
        this.warmsSkippedIdle++;
        this.lastSkipReason = 'no_user_messages_ever';
        return;
      }
      if (minutesAgo < MIN_GAP) {
        // Cache is still hot from real traffic — warming would waste money
        this.warmsSkippedRecent++;
        this.lastSkipReason = `cache_still_hot (last msg ${minutesAgo.toFixed(1)}min ago, < ${MIN_GAP}min)`;
        return;
      }
      if (minutesAgo > MAX_GAP) {
        // Bot has been idle for ages — let cache stay cold, save the $0.0006
        this.warmsSkippedIdle++;
        this.lastSkipReason = `idle_too_long (last msg ${Math.round(minutesAgo)}min ago, > ${MAX_GAP}min)`;
        return;
      }

      // Use the same tool subset as the most-common intent path: 'reminder'.
      // This warms the cache entry users hit ~60% of the time. Other
      // categories (calendar, email) will still pay first-call write premium
      // occasionally; we don't try to warm every category because that would
      // cost more than it saves at this scale.
      const llm = require('../services/llm-provider');
      const { getToolsForCategory } = require('../services/tool-definitions');
      // Must byte-match the subset ai.service.js::detectIntent sends, or the
      // warmed prefix is a different cache entry (tools are part of the
      // prompt-cache identity). Keep the limit resolution identical.
      const subsetLimit = parseInt(process.env.TOOL_SUBSET_LIMIT || '24', 10);
      const tools = getToolsForCategory('reminder', subsetLimit);

      // Match the EXACT system prompt prefix that ai.service.js uses for
      // intent detection. If the prompt diverges from intent's actual prompt,
      // the cache lookups won't hit and the warmer is useless.
      // We strip the dynamic workflow-context block since cache_control marks
      // only the static prefix anyway.
      const systemPrompt = this._buildIntentSystemPrompt();

      const start = Date.now();
      const resp = await llm.chatCompletion({
        model: process.env.MODEL_INTENT_PRIMARY || 'claude-haiku-4.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'ping' }
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 5,            // tiny output keeps cost minimal
        temperature: 0
      }, { timeout: 10_000, enablePromptCache: true });

      const elapsed = Date.now() - start;
      const usage = resp?.data?.usage || {};
      this.warmsToday++;
      this.lastWarmAt = new Date();

      logger.debug(
        `[CacheWarmer] warmed in ${elapsed}ms ` +
        `(input=${usage.prompt_tokens || 0}, ` +
        `cached_read=${usage.cache_read_input_tokens || 0}, ` +
        `cache_write=${usage.cache_creation_input_tokens || 0}, ` +
        `output=${usage.completion_tokens || 0})`
      );
    } catch (e) {
      this.warmsFailed++;
      logger.warn(`[CacheWarmer] warm failed: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Returns minutes since the most recent user message in conversation_history,
   * or null if there are no user messages ever (fresh install / wiped table).
   * Used to decide whether to warm: too-recent = skip, too-old = skip, sweet
   * spot = warm.
   */
  async _getMinutesSinceLastUserMessage() {
    try {
      const { query } = require('../config/database');
      const r = await query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 60 AS minutes_ago
         FROM conversation_history WHERE role = 'user'`
      );
      const m = r.rows[0]?.minutes_ago;
      return m === null || m === undefined ? null : Number(m);
    } catch (e) {
      // DB error → return a sweet-spot value so we warm anyway. Better to
      // over-warm than under-warm when DB is shaky.
      return 5;
    }
  }

  /**
   * Build the static prefix of the intent system prompt — identical to what
   * `ai.service.js::detectIntent()` constructs, minus dynamic workflow hints.
   * Keep this in sync with that file or the cache won't be reused.
   */
  _buildIntentSystemPrompt() {
    // Delegate to the SAME builders ai.service.js::detectIntent() uses, with
    // the same "no active workflow" hint text, so the warmed prefix actually
    // byte-matches what runtime intent calls send. A hardcoded copy of the v1
    // prompt lived here before and silently diverged as prompt versions moved.
    try {
      const aiService = require('../services/ai.service');
      const noHints = aiService.formatIntentContextHints({});
      const version = process.env.INTENT_PROMPT_VERSION || 'v3';
      if (version === 'v3') return aiService._buildIntentSystemPromptV3(noHints);
      if (version === 'v2') return aiService._buildIntentSystemPromptV2(noHints);
      // v1 has no builder method (inline template in detectIntent) — fall
      // through to the legacy static stub below.
    } catch (e) {
      // Never let the warmer break on a require/refactor issue.
    }
    return `You are an intent detection system for a WhatsApp AI assistant called Ari. Your job is to decide if the user's message requires a specific action (call the appropriate tool) or is just casual conversation (don't call any tool).

RULES:
- Understand the FULL message meaning in ANY language (English, Hindi, Hinglish, French, Spanish, German, Arabic, etc.)
- The CURRENT message always takes priority over conversation history. Classify based on what the user is asking RIGHT NOW, not what they asked earlier.
- Use conversation history and active workflow state to resolve ambiguous follow-ups like "yes", "do it", "cancel this", "option 1"
- If the user is just chatting, saying something that doesn't need an action - do NOT call any tool

(cache-warmer ping — full prompt loaded by ai.service.js for actual intent calls)`;
  }

  /** Snapshot for /health endpoints */
  getStats() {
    return {
      enabled: process.env.CACHE_WARMER_ENABLED !== 'false' && !!process.env.ANTHROPIC_API_KEY,
      warms_today: this.warmsToday,
      warms_skipped_idle: this.warmsSkippedIdle,
      warms_skipped_recent: this.warmsSkippedRecent,
      warms_failed: this.warmsFailed,
      last_warm_at: this.lastWarmAt,
      last_skip_reason: this.lastSkipReason,
    };
  }
}

module.exports = new AnthropicCacheWarmerJob();
