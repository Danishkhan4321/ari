const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const BoundedMap = require('../utils/bounded-map');
const { filterToCurrentSession } = require('../utils/history-session-filter');
const { sanitizeAssistantHistoryForLLM } = require('../utils/history-sanitizer');
const { isAiCallLimited } = require('../middleware/abuse-protection');
const { openaiBreaker } = require('../utils/circuit-breakers');
const { llmTrace } = require('../utils/llm-trace');
const { generateObject } = require('ai');
const llm = require('./llm-provider');
const { z } = require('zod');
const { currentChatSession } = require('./chat-session-context');

// Zod schemas for the SDK-migrated classifiers.
const ResumeIntentSchema = z.object({
  intent: z.enum(['visa', 'save'])
});
// OpenAI's strict Structured Outputs requires every field to be in `required`.
// Use .nullable() instead of .optional() to allow "this field may not apply".
const CriteriaPickerSchema = z.object({
  is_picker_reply: z.boolean(),
  categories: z.union([
    z.literal('all'),
    z.array(z.string())
  ]).nullable(),
  location: z.object({
    mode: z.enum(['anywhere', 'online', 'specific']),
    value: z.string().nullable()
  }).nullable()
});
const StandupAlignmentSchema = z.object({
  completed: z.array(z.string()).default([]),
  missed: z.array(z.string()).default([]),
  unplanned: z.array(z.string()).default([]),
  alignment_score: z.number().int().min(0).max(100),
  summary: z.string()
});

// All LLM routing (OpenAI / Groq / Gemini) goes through src/services/llm-provider.
// The constants below are kept as aliases so older code paths keep working.
const OPENAI_API_URL = llm.chatUrl();
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function enforceExplicitReminderIntent(message, toolName, params) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  if (!text || /^(?:cancel|delete|remove|show|list|view|update|change|edit)\b/.test(lower)) {
    return { toolName, params };
  }

  const explicitReminder = /^(?:please\s+)?(?:(?:send|set|create)\s+)?(?:a\s+)?reminder\b/i.test(text)
    || /^(?:please\s+)?remind\s+/i.test(text);

  if (!explicitReminder || toolName === 'set_reminder') {
    return { toolName, params };
  }

  const recipientMatch = text.match(
    /^(?:please\s+)?(?:send\s+)?(?:a\s+)?reminder\s+(?:to|for)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}?)(?=\s+(?:at|on|in|by|tomorrow|today|tonight|next|every|daily|weekly|monthly|to)\b|[,.;]|$)/i
  ) || text.match(
    /^(?:please\s+)?remind\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}?)(?=\s+(?:at|on|in|by|tomorrow|today|tonight|next|every|daily|weekly|monthly|to)\b|[,.;]|$)/i
  );

  const correctedParams = { ...params, full_text: text };
  if (recipientMatch) {
    const candidate = recipientMatch[1].trim();
    if (!/^(?:me|myself|tomorrow|today|tonight|next|every)$/i.test(candidate)) {
      correctedParams.target_name = candidate;
    }
  }

  return { toolName: 'set_reminder', params: correctedParams };
}

class AIService {

  constructor() {
    // Auth + URL + model slots are resolved by the central provider.
    // This used to be an OpenAI-or-Groq switch; it's now provider-aware.
    this.apiKey = llm.apiKey();
    this.apiUrl = llm.chatUrl();
    this.model = llm.defaultModel();
    this.fastModel = llm.fastModel();
    // Intent-detection slot: historically used a cheaper model (nano). Under
    // Gemini — one flat rate per model — there's no cost win in picking a
    // smaller model, so we just reuse fastModel. The OPENAI_INTENT_MODEL env
    // var is only honored when the active provider is actually OpenAI.
    this.intentModel = (llm.providerName() === 'openai' && process.env.OPENAI_INTENT_MODEL)
      ? process.env.OPENAI_INTENT_MODEL
      : llm.fastModel();
    this.useOpenAI = llm.providerName() === 'openai';

    logger.info(`AI Service: Using ${llm.providerName()} (chat: ${this.model} / fast: ${this.fastModel} / intent: ${this.intentModel})`);

    // Settings - configurable via env vars
    //
    // Defaults were dramatically tightened (336h/100msg → 4h/20msg) to fix
    // the "kainsl vn en too" hallucination class: the LLM was being fed
    // up to 100 messages from the last 14 days as `messages: [...history]`
    // and improvising clarification examples by splicing fragments of
    // old voice-transcribed messages into fresh `Example: "Remind X: ..."`
    // lines. Tighter defaults + the session-boundary filter in
    // history-session-filter.js cut that off at the source.
    //
    // Operators who genuinely need a wider window can still override:
    //   AI_HISTORY_HOURS=24
    //   AI_MAX_MESSAGES=50
    //   AI_SESSION_GAP_MINUTES=120   (raise to make sessions stickier)
    this.historyHours = parseInt(process.env.AI_HISTORY_HOURS) || 4;
    this.maxMessagesForAPI = parseInt(process.env.AI_MAX_MESSAGES) || 20;
    this.sessionGapMinutes = parseInt(process.env.AI_SESSION_GAP_MINUTES) || 60;
    this.maxStoredMessages = parseInt(process.env.AI_MAX_STORED) || 500;
    this.intentRecentMessages = parseInt(process.env.AI_INTENT_RECENT_MESSAGES) || 25;
    this.intentContextTruncate = parseInt(process.env.AI_INTENT_CONTEXT_TRUNCATE) || 500;
    // Assistant turns get a larger budget: they contain the numbered lists /
    // option menus that positional replies ("the 5th one", "#7") resolve
    // against. At 500 chars an 8-item list is cut after item ~3 and the LLM
    // literally cannot see the item the user picked.
    this.intentContextTruncateAssistant = parseInt(process.env.AI_INTENT_CONTEXT_TRUNCATE_ASSISTANT) || 1500;

    // In-memory cache for performance (bounded, auto-expiring)
    // Short TTL (30s) to prevent stale context when messages arrive rapidly
    this.historyCache = new BoundedMap(10000, 30 * 1000);
    this.cacheExpiry = 30 * 1000; // Cache for 30 seconds (was 5 min — caused stale responses)

    // Summary cache for conversation summarization
    this.summaryCache = new BoundedMap(10000, 30 * 60 * 1000);

    // Global conversation history pruning — runs daily at 3 AM
    this._startPruningJob();
  }

  _startPruningJob() {
    const PRUNE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

    // Stable lock id for the conversation_history pruner. Any int4 works;
    // pick a value unlikely to collide with future advisory-lock callers.
    // Using session-level pg_try_advisory_lock so the lock is auto-released
    // when the connection returns to the pool (which happens at the end of
    // each query() call) — that's effectively per-statement, which is fine
    // because the DELETE itself is fast.
    const PRUNE_LOCK_ID = 924071; // arbitrary, project-stable

    const runPrune = async () => {
      try {
        // Apr 29 2026: gate the DELETE behind a Postgres advisory lock.
        // If we ever scale to >1 pod, every pod's setInterval would fire
        // the same DELETE concurrently — wasted work + lock contention.
        // pg_try_advisory_xact_lock returns false if another pod holds it,
        // and we cleanly skip without waiting.
        const lockResult = await query(
          `SELECT pg_try_advisory_lock($1) AS got_lock`,
          [PRUNE_LOCK_ID]
        );
        if (!lockResult.rows[0]?.got_lock) {
          logger.debug('Conversation pruning: another instance holds the lock, skipping');
          return;
        }
        try {
          const result = await query(
            `DELETE FROM conversation_history WHERE created_at < NOW() - INTERVAL '30 days'`
          );
          if (result.rowCount > 0) {
            logger.info(`Pruned ${result.rowCount} old conversation_history rows (>30 days)`);
          }
        } finally {
          // Always release, even on DELETE failure.
          await query(`SELECT pg_advisory_unlock($1)`, [PRUNE_LOCK_ID]).catch(() => {});
        }
      } catch (e) {
        logger.warn(`Conversation history pruning failed: ${e.message}`);
      }
    };

    // First run after 60s startup delay, then every 24h.
    // Both timers are .unref()'d so they can't pin the event loop open
    // when SIGTERM arrives — the DELETE is idempotent, missing one tick
    // is harmless, and the next pod boot picks it up.
    const startup = setTimeout(() => {
      runPrune().catch(() => {});
      const interval = setInterval(() => {
        runPrune().catch(() => {});
      }, PRUNE_INTERVAL);
      if (interval.unref) interval.unref();
      this._pruneInterval = interval;
    }, 60 * 1000);
    if (startup.unref) startup.unref();
    this._pruneStartup = startup;
  }

  /**
   * Centralized OpenAI/Groq HTTP call wrapped with:
   *  1. Circuit breaker — fails fast during upstream outages instead of stalling
   *  2. Langfuse tracing — per-call observability for cost/latency/debugging
   *
   * All call sites in this service use this helper so the breaker sees ALL OpenAI
   * traffic (essential for accurate error-rate calculations).
   *
   * @param {object} body - OpenAI request body (model, messages, tools, ...)
   * @param {object} [options]
   * @param {number} [options.timeout] - axios timeout ms (default 60000)
   * @param {string} [options.traceName] - name for Langfuse trace
   * @param {string} [options.userId] - user phone for Langfuse user attribution
   * @returns {Promise<object>} axios response (same shape as before)
   */
  async _callOpenAI(body, options = {}) {
    const timeout = options.timeout || 60000;
    const traceName = options.traceName || 'openai.chat';
    const userId = options.userId;
    // Gemini thinking-model defaults — callers don't need to know about them,
    // but without this `reasoning_effort: 'minimal'` Gemini 3 Flash spends the
    // whole token budget on thinking and returns empty content. Caller-passed
    // fields win (so tool-using calls can set 'low' or 'medium' explicitly).
    const bodyWithDefaults = { ...llm.defaultBodyExtras(options.slot || 'default'), ...body };

    // Build the thunk that actually makes the HTTP call. The breaker wraps
    // this. Bedrock-aware: llm.chatCompletion routes to bedrock-adapter when
    // LLM_PROVIDER=bedrock, otherwise falls back to axios.post with the right
    // URL/headers. Was previously hitting 'bedrock://converse' sentinel
    // directly via axios → "Unsupported protocol bedrock:" failures.
    const doCall = async () => llm.chatCompletion(bodyWithDefaults, { timeout });

    // Wrap with Langfuse tracing (no-op if LANGFUSE_* env vars unset).
    const traced = await llmTrace({
      name: traceName,
      userId,
      model: body.model,
      input: body.messages,
      metadata: {
        tools: body.tools ? body.tools.length : undefined,
        tool_choice: body.tool_choice,
        temperature: body.temperature
      }
    }, async () => {
      // Route through circuit breaker. On open, the fallback returns
      // { degraded: true, ... } — we convert that to a throw so callers using
      // try/catch still degrade gracefully.
      const result = await openaiBreaker.fire(doCall);
      if (result && result.degraded) {
        const err = new Error(`OpenAI circuit open: ${result.reason}`);
        err.degraded = true;
        err.fallbackText = result.text;
        throw err;
      }
      return result;
    });

    return traced;
  }

  // ========== DATABASE HISTORY MANAGEMENT ==========

  _historyKey(userPhone) {
    const session = currentChatSession();
    return session?.sessionId ? `${userPhone}::session:${session.sessionId}` : userPhone;
  }

  async saveMessage(userPhone, role, content) {
    try {
      const session = currentChatSession();
      let result;
      if (session?.sessionId) {
        // Correlate the assistant reply with the dashboard submission too.
        // The dashboard uses this to settle only the run that produced the
        // reply, instead of treating an older assistant message as completion.
        const clientMessageId = session.clientMessageId;
        result = await query(
          `INSERT INTO conversation_history
             (user_phone, role, content, session_id, client_message_id, created_at)
           VALUES ($1::varchar, $2::varchar, $3::text, $4::uuid, $5::uuid, NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userPhone, role, content, session.sessionId, clientMessageId]
        );
        if (result.rowCount > 0) {
          await query(
            `UPDATE ari_chat_sessions
                SET updated_at = NOW(),
                    title = CASE
                      WHEN $2::varchar = 'user' AND (title IS NULL OR title = '')
                        THEN LEFT($3::text, 120)
                      ELSE title
                    END
              WHERE id = $1::uuid`,
            [session.sessionId, role, content]
          );
        }
      } else {
      // Duplicate guard: several paths can legitimately try to persist the
      // same exchange (agent-loop parity save vs a handler that internally
      // calls chat(); document-caption turns that save the caption before
      // rerouting it). One INSERT ... WHERE NOT EXISTS keeps history clean
      // without coordinating every writer: an identical (user, role, content)
      // row within the last 15s is the same logical message, not a repeat.
      // Explicit casts are required: with the same parameter used in both
      // the SELECT list and the WHERE comparison, Postgres deduces
      // conflicting types and rejects the statement ("inconsistent types
      // deduced for parameter $1").
        result = await query(
        `INSERT INTO conversation_history (user_phone, role, content, session_id, created_at)
         SELECT $1::varchar, $2::varchar, $3::text, NULL, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_history
             WHERE user_phone = $1::varchar AND role = $2::varchar AND content = $3::text
               AND session_id IS NULL
               AND created_at > NOW() - INTERVAL '15 seconds'
          )`,
        [userPhone, role, content]
      );
      }

      // Only cache rows this call actually inserted. A repeated dashboard
      // submission carries the same client message UUID and is a no-op.
      if (result.rowCount > 0) this.updateCache(userPhone, role, content);

      // Cleanup old messages periodically (~5% of saves) instead of every save
      if (Math.random() < 0.05) {
        await this.cleanupUserHistory(userPhone);
      }

    } catch (error) {
      if (error.message.includes('does not exist') && !currentChatSession()?.sessionId) {
        await this.createHistoryTable();
        return this.saveMessage(userPhone, role, content);
      }
      logger.error('Error saving message:', error.message);
    }
  }

  async getHistory(userPhone) {
    try {
      const session = currentChatSession();
      const cacheKey = this._historyKey(userPhone);
      // Check cache first — return a copy to prevent mutation by callers
      const cached = this.historyCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        return cached.messages.map(m => ({ ...m }));
      }

      // Fetch from database - messages within history window
      const result = session?.sessionId
        ? await query(
          `SELECT role, content, created_at
             FROM (
               SELECT role, content, created_at
                 FROM conversation_history
                WHERE user_phone = $1 AND session_id = $2::uuid
                ORDER BY created_at DESC
                LIMIT $3
             ) recent
            ORDER BY created_at ASC`,
          [userPhone, session.sessionId, this.maxMessagesForAPI]
        )
        : await query(
          `SELECT role, content, created_at
             FROM (
               SELECT role, content, created_at
                 FROM conversation_history
                WHERE user_phone = $1
                  AND session_id IS NULL
                  AND created_at > NOW() - INTERVAL '1 hour' * $3
                ORDER BY created_at DESC
                LIMIT $2
             ) recent
            ORDER BY created_at ASC`,
          [userPhone, this.maxMessagesForAPI, this.historyHours]
        );

      // Session-boundary filter — drop everything before the latest
      // gap > sessionGapMinutes. Stops yesterday's "cancel 1 & 2" and
      // old voice-transcription fragments from leaking into today's
      // LLM context. See utils/history-session-filter.js for full
      // rationale and the test cases in scripts/test-history-session-filter.js.
      const sessionRows = session?.sessionId
        ? result.rows
        : filterToCurrentSession(result.rows, this.sessionGapMinutes);

      const rawMessages = sessionRows.map(row => ({
        role: row.role,
        content: row.content
      }));

      // Sanitize assistant turns: strip "Example: …" / "Try: …" lines from
      // prior assistant replies. The system prompt already forbids the LLM
      // from splicing fragments into fresh Example: lines, but with the
      // prior content right there in the messages array the LLM ignores
      // the rule. Removing the source material is the structural fix.
      // User turns are never modified.
      const messages = sanitizeAssistantHistoryForLLM(rawMessages);

      // Update cache
      this.historyCache.set(cacheKey, {
        messages,
        timestamp: Date.now()
      });

      return messages;

    } catch (error) {
      if (error.message.includes('does not exist')) {
        await this.createHistoryTable();
        return [];
      }
      logger.error('Error getting history:', error.message);
      return [];
    }
  }

  // ========== CONVERSATION SUMMARIZATION ==========

  async getHistoryWithSummarization(userPhone) {
    const history = await this.getHistory(userPhone);

    // ⚡ Phase 5 token optimization: Aggressive summarization thresholds.
    // mem0 benchmark (state-of-ai-agent-memory-2026): 90% history token
    // reduction + 26% accuracy improvement when keeping ~5 verbatim msgs +
    // rolling summary, triggered earlier (~12 msgs vs original 30).
    //
    // Multi-turn workflows ("done 5 & 6", confirmations, follow-ups) are
    // typically within 3-5 messages — 5 verbatim covers them cleanly.
    //
    // OPT_CONVERSATION_SUMMARY=true → tight thresholds (12 / 5)
    // OPT_CONVERSATION_SUMMARY=false (default) → conservative (30 / 20)
    const aggressive = process.env.OPT_CONVERSATION_SUMMARY === 'true';
    const TRIGGER_THRESHOLD = aggressive ? 12 : 30;
    const KEEP_RECENT = aggressive ? 5 : 20;

    if (history.length <= TRIGGER_THRESHOLD) return history;

    const oldMessages = history.slice(0, -KEEP_RECENT);
    const recentMessages = history.slice(-KEEP_RECENT);

    // Check if we already have a valid summary for this count
    const summaryKey = this._historyKey(userPhone);
    const cached = this.summaryCache.get(summaryKey);
    if (cached && cached.messageCount === oldMessages.length) {
      return [
        { role: 'system', content: `Previous conversation summary: ${cached.summary}` },
        ...recentMessages
      ];
    }

    try {
      const oldText = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000);
      // Bedrock-aware path. axios.post(this.apiUrl) hits the
      // 'bedrock://converse' sentinel URL when LLM_PROVIDER=bedrock and fails
      // with "Unsupported protocol bedrock:" — same bug that blocked visa
      // searches and meeting-summary generation. Use llm.chatCompletion which
      // routes correctly per provider.
      const response = await llm.chatCompletion({
        model: this.fastModel,
        messages: [
          { role: 'system', content: 'Summarize this conversation concisely. Include key facts, decisions, names mentioned, and topics discussed. Output plain text, 2-4 sentences max.' },
          { role: 'user', content: oldText }
        ],
        temperature: 0.3,
        max_tokens: 300,
        ...llm.defaultBodyExtras()
      }, { timeout: 10000 });

      const summary = response.data.choices[0].message.content;

      // Cache the summary
      this.summaryCache.set(summaryKey, { summary, messageCount: oldMessages.length });

      return [
        { role: 'system', content: `Previous conversation summary: ${summary}` },
        ...recentMessages
      ];
    } catch (error) {
      logger.warn('Summarization failed, using recent messages only:', error.message);
      return recentMessages;
    }
  }

  updateCache(userPhone, role, content) {
    const cached = this.historyCache.get(this._historyKey(userPhone));
    if (cached) {
      // Create new array instead of mutating — prevents race conditions
      // when multiple messages are being processed concurrently
      const newMessages = [...cached.messages, { role, content }];
      cached.messages = newMessages.length > this.maxMessagesForAPI
        ? newMessages.slice(-this.maxMessagesForAPI)
        : newMessages;
      cached.timestamp = Date.now();
    }
  }

  async cleanupUserHistory(userPhone) {
    try {
      const session = currentChatSession();
      // Keep only last N messages per user
      if (session?.sessionId) {
        await query(
          `DELETE FROM conversation_history
            WHERE user_phone = $1 AND session_id = $2::uuid
              AND id NOT IN (
                SELECT id FROM conversation_history
                 WHERE user_phone = $1 AND session_id = $2::uuid
                 ORDER BY created_at DESC
                 LIMIT $3
              )`,
          [userPhone, session.sessionId, this.maxStoredMessages]
        );
      } else {
        await query(
          `DELETE FROM conversation_history
           WHERE user_phone = $1
             AND session_id IS NULL
           AND id NOT IN (
             SELECT id FROM conversation_history
             WHERE user_phone = $1 AND session_id IS NULL
             ORDER BY created_at DESC
             LIMIT $2
           )`,
          [userPhone, this.maxStoredMessages]
        );
      }
    } catch (error) {
      logger.error('Error cleaning up history:', error.message);
    }
  }

  async clearHistory(userPhone, options = {}) {
    try {
      const session = currentChatSession();
      if (session?.sessionId) {
        await query(
          `DELETE FROM conversation_history WHERE user_phone = $1 AND session_id = $2::uuid`,
          [userPhone, session.sessionId]
        );
      } else {
        await query(
          `DELETE FROM conversation_history WHERE user_phone = $1 AND session_id IS NULL`,
          [userPhone]
        );
      }
      const cacheKey = this._historyKey(userPhone);
      this.historyCache.delete(cacheKey);
      this.summaryCache.delete(cacheKey);
      if (options.deferAgentState !== true) {
        const {
          conversationIdentity,
          openRouterAgentPersistence,
        } = require('./openrouter-agent-state.service');
        const conversationKey = conversationIdentity(userPhone, session?.sessionId || null);
        await openRouterAgentPersistence.withConversationLock(conversationKey, (queryFn) =>
          openRouterAgentPersistence.clearConversation({ conversationKey, queryFn }));
      }
      logger.info(`Cleared history for ${userPhone}`);
      return true;
    } catch (error) {
      logger.error('Error clearing history:', error.message);
      return false;
    }
  }

  async createHistoryTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS conversation_history (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          role VARCHAR(20) NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Apr 29 2026: dropped the single-column `idx_conversation_user_phone`
      // creation. Production already has a composite
      // `idx_conversation_user_created (user_phone, created_at DESC)` which
      // Postgres uses for both user-only and user+time-ordered queries —
      // the single-column version was redundant disk + write overhead.
      // (To remove the existing index on production:
      //   DROP INDEX IF EXISTS idx_conversation_user_phone;
      // Run as a one-shot when convenient.)
      await query(`CREATE INDEX IF NOT EXISTS idx_conversation_created_at ON conversation_history(created_at)`);
      logger.info('Created conversation_history table');
    } catch (error) {
      logger.error('Error creating history table:', error.message);
    }
  }

  // ========== MAIN CHAT FUNCTION ==========

  async chat(userPhone, message, context = {}, options = {}) {
    try {
      // Check AI call budget before making expensive API call
      if (isAiCallLimited(userPhone)) {
        return "You've sent a lot of messages quickly. Please wait a moment before sending more.";
      }

      // ⚡ Phase 6: Semantic response cache — skip LLM entirely for safe-cacheable
      // queries (greetings, thanks, "what can you do", etc.) when the user has
      // recently asked something semantically similar. Whitelist-only — never
      // caches stateful queries (anything with my/today/dates/digits/action verbs).
      // Disabled by default — activate via OPT_RESPONSE_CACHE=true.
      if (process.env.OPT_RESPONSE_CACHE === 'true') {
        try {
          const respCache = require('./response-cache.service');
          const cached = await respCache.lookup(userPhone, message);
          if (cached && cached.response) {
            logger.info(`[Chat] Served from response cache (score=${cached.score.toFixed(3)})`);
            // Still record the user turn so history stays consistent (handler
            // bypassed assistant turn — log it so getHistory returns it later).
            await this.saveMessage(userPhone, 'user', message);
            await this.saveMessage(userPhone, 'assistant', cached.response);
            return cached.response;
          }
        } catch (e) {
          // Never block chat on cache error.
          logger.warn(`[Chat] Response cache lookup errored, falling through: ${e.message}`);
        }
      }

      // Ari patch (Phase 2): Agentic chat via Vercel AI SDK.
      // When the feature flag is on AND the caller passed a toolExecutor, route
      // to the agentic loop that can call multiple tools in sequence, see each
      // result, and keep reasoning until done. Fallback: the plain LLM-chat
      // path below is unchanged.
      if (
        process.env.AGENTIC_CHAT_ENABLED === 'true' &&
        typeof options.toolExecutor === 'function'
      ) {
        try {
          return await this._chatAgentic(userPhone, message, context, options);
        } catch (agErr) {
          logger.error(`[AgenticChat] Failed, falling back to plain chat: ${agErr.message}`);
          // Fall through to plain chat below — never leave user without a reply.
        }
      }

      // Get history with summarization for long conversations
      const history = await this.getHistoryWithSummarization(userPhone);

      // Ari patch (Phase 1): Rich always-on context injection.
      // Pulls user profile + today's calendar + pending tasks + semantic memories
      // relevant to the current message and prepends to the system prompt.
      // This is what makes an assistant feel "ChatGPT-smart" — it knows things
      // without being told. Fails open: empty string on any error.
      let contextBlock = '';
      try {
        const contextBuilder = require('./context-builder.service');
        contextBlock = await contextBuilder.build(userPhone, message);
      } catch (ctxErr) {
        logger.warn('[Chat] Context build failed: ' + ctxErr.message);
      }

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(context, history.length) + contextBlock;

      // Build messages array
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history
      if (history.length > 0) {
        messages.push(...history);
      }

      // Add current message
      messages.push({ role: 'user', content: message });

      logger.info(`Chat with ${history.length} history messages for ${userPhone}`);

      // Call API through breaker + Langfuse trace. withRetry handles transient
      // 429/503 inside the breaker — the breaker handles sustained outages.
      // Route general chat via modelFor('chat') when env flag is set — Nova Pro
      // as default fallback takes load off Gemini (which has aggressive rate
      // limits). Falls through to current this.model when flag is unset.
      const llmProvider = require('./llm-provider');
      const chatTaskModel = llmProvider.modelFor('chat');
      const useRoutedChat = chatTaskModel && chatTaskModel !== this.model;

      let response;
      if (useRoutedChat) {
        response = await withRetry(() => llmProvider.chatCompletion({
          model: chatTaskModel,
          messages,
          temperature: 0.6,
          max_tokens: 800,
        }, {
          task: 'chat',
          timeout: 15000,
        }), { maxRetries: 2, baseDelay: 1000 });
        try {
          const tracker = require('./model-usage-tracker.service');
          tracker.log({ task: 'chat', model: chatTaskModel, usage: response?.data?.usage, userPhone });
        } catch (_) {}
      } else {
        response = await withRetry(() => this._callOpenAI({
          model: this.model,
          messages,
          temperature: 0.6,
          max_tokens: 800
        }, {
          timeout: 15000,
          traceName: 'chat',
          userId: userPhone
        }), { maxRetries: 2, baseDelay: 1000 });
      }

      const aiResponse = response.data.choices[0].message.content;

      // ─── PHASE 2: HALLUCINATION DETECTOR ───────────────────────────
      // Catch past-tense ACTION CLAIMS in chat replies (no tool ran). The
      // tricky part is differentiating actual claims ("I assigned the task")
      // from harmless modal/interrogative uses ("want me to set X?", "can I
      // set X for you?"). The regex must REQUIRE a declarative subject
      // (I/I've/successfully/done/just) AND avoid matching when preceded by
      // a question mark, "want me to", "should I", etc.
      try {
        // Strip out interrogative clauses first — anything inside "want me to ..."
        // / "should I ..." / "can I ..." / sentences ending in "?" — those are
        // questions, not claims.
        const lower = String(aiResponse).toLowerCase();
        const questionScrubbed = lower
          .split(/[.!?\n]/)                              // sentence-by-sentence
          .filter(s => !/(want\s+me\s+to|should\s+i|can\s+i|shall\s+i|do\s+you\s+want|would\s+you\s+like|let\s+me\s+know|just\s+confirm)/i.test(s))
          .join('. ');

        const declarativeClaims = [
          // English: needs explicit subject like "I've assigned" / "Task assigned" / "Successfully sent"
          /\b(?:i[' ]?ve\s+|i\s+(?:just\s+)?(?:have\s+)?|i'?ll\s+have\s+|done\s+[—-]\s*i\s+|successfully\s+|already\s+|just\s+now\s+)(?:assigned|created|sent|scheduled|set|saved|added|deleted|completed|booked|cancelled|notified|reminded|delivered|posted)\b/i,
          // Past-participle adjective form: "Task assigned to Akash" — the subject is the noun
          /\b(?:task|reminder|email|message|meeting|note|contact|poll|standup)\s+(?:has\s+been\s+|was\s+|is\s+now\s+)?(?:assigned|created|sent|scheduled|saved|added|completed|booked|cancelled|posted)\s+(?:to|with|for)\b/i,
          // Hinglish past-tense doing
          /\b(kar|bhej|set|assign|send|kr)\s*(diy[aā]|li[aā]|d[ie])\b/i,
          /\byaad\s*dilay[aā]/i,
        ];
        const looksHallucinated = declarativeClaims.some(p => p.test(questionScrubbed));
        if (looksHallucinated) {
          logger.warn(`[HallucinationDetector] CHAT reply may be claiming an action without a tool call. user=${userPhone} reply="${String(aiResponse).slice(0, 200)}"`);
        }
      } catch (_) { /* never break a chat reply on detector failure */ }

      // Save both messages to database
      await this.saveMessage(userPhone, 'user', message);
      await this.saveMessage(userPhone, 'assistant', aiResponse);

      // Phase 6: Store the assistant reply in response cache (only fires for
      // safe-cacheable queries — greetings/thanks/help patterns; never for
      // stateful queries). Fire-and-forget; cache failures never break chat.
      if (process.env.OPT_RESPONSE_CACHE === 'true') {
        try {
          const respCache = require('./response-cache.service');
          respCache.store(userPhone, message, aiResponse).catch(() => {});
        } catch (_) { /* never break chat on cache store */ }
      }

      // Ari patch (Phase 1): Auto-extract facts from every conversation pair.
      // Mem0's LLM decides what's worth remembering (preferences, relationships,
      // ongoing projects). This runs BESIDE the existing explicit "remember X"
      // flow in memory.service.js — together they populate the user's long-term
      // memory passively and let search find things on future turns.
      // Fire-and-forget: never block the reply.
      try {
        const mem0Service = require('./mem0-memory.service');
        if (mem0Service.isAvailable && mem0Service.isAvailable()) {
          const conversation = [
            { role: 'user', content: message },
            { role: 'assistant', content: aiResponse },
          ];
          mem0Service
            .add(conversation, userPhone, { source: 'chat_auto', ts: Date.now() })
            .catch(memErr => logger.warn('[Chat] Mem0 auto-add failed: ' + memErr.message));
        }
      } catch (_) { /* memory is a nice-to-have, never break chat on it */ }

      // Fire-and-forget LLM-as-a-Judge quality scoring (opt-in via LLM_JUDGE_ENABLED).
      // Uses Groq free tier — zero added latency, zero added $ cost. Posts score
      // back to Langfuse for trend analysis + alerts via Sentry on low scores.
      try {
        const judge = require('./llm-judge.service');
        if (judge.shouldJudge()) {
          judge.judgeAsync({
            userId: userPhone,
            userMessage: message,
            botResponse: aiResponse,
            intent: 'chat'
          });
        }
      } catch (e) { /* judge is a nice-to-have, never break chat on it */ }

      return aiResponse;

    } catch (error) {
      // Circuit breaker open — return the fallback text.
      if (error.degraded && error.fallbackText) {
        return error.fallbackText;
      }

      const status = error.response?.status;
      const errDetail = error.response?.data
        ? JSON.stringify(error.response.data)
        : (error.message || error.code || String(error));
      logger.error(`AI chat error [${status || error.code || 'unknown'}]: ${errDetail}`);

      if (status === 401) return "AI service authentication failed. Please check API keys.";
      if (status === 429) return "I'm getting too many requests right now. Please wait a moment and try again.";
      if (status === 503 || status === 502) return "AI service is temporarily unavailable. Try again in a minute.";
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return "Response took too long. Try again with a shorter message?";
      return "Sorry, I'm having trouble thinking right now. Try again?";
    }
  }

  // ========== AGENTIC CHAT (Phase 2) ==========
  //
  // Uses Vercel AI SDK's generateText() with stopWhen: stepCountIs(N).
  // The LLM can call multiple tools in sequence, see each result, and keep
  // reasoning until it has a final answer. This closes the "single-shot" gap
  // in the original chat() path.
  //
  // Example of what becomes possible:
  //   User: "email my resume to whoever interviewed me last week"
  //     Step 1: LLM calls recall_memory("who interviewed me") → "Rahul at TechCorp"
  //     Step 2: LLM calls manage_contacts("get Rahul email") → "rahul@techcorp.com"
  //     Step 3: LLM calls send_email(to=rahul@..., subject, body, attach=resume.pdf)
  //     Step 4: LLM replies "Sent to Rahul ✅"
  //
  // Safety:
  //   - stopWhen: stepCountIs(8) — hard cap on runaway loops
  //   - maxRetries: 2 inside the SDK
  //   - Tool errors return "Error: <msg>" string, LLM decides next move
  //   - 45-second total timeout (WhatsApp user won't wait longer)
  //
  async _chatAgentic(userPhone, message, context, options) {
    const { generateText, stepCountIs, tool, jsonSchema } = require('ai');
    const { getToolDefinitions, getIntentForTool, getToolsForMessage } = require('./tool-definitions');

    // ── Build context (same as plain chat) ──
    const history = await this.getHistoryWithSummarization(userPhone);
    let contextBlock = '';
    try {
      const contextBuilder = require('./context-builder.service');
      contextBlock = await contextBuilder.build(userPhone, message);
    } catch (e) {
      logger.warn('[AgenticChat] Context build failed: ' + e.message);
    }
    const systemPrompt = this.buildSystemPrompt(context, history.length) + contextBlock +
      '\n\nYou have tools to actually DO things for the user (not just talk). Call tools whenever helpful. You can call multiple tools in sequence — after each tool result, decide whether to call another tool or write the final reply. Keep chains short and purposeful.';

    // ── Convert OpenAI-format tools → Vercel AI SDK format ──
    // Use subsetting: pick category-relevant tools (max 20) so the agentic loop
    // doesn't drown in schemas.
    const { category, tools: rawTools } = getToolsForMessage(message, 20);
    if (category) {
      logger.info(`[AgenticChat] Tool subset: category=${category}, count=${rawTools.length}`);
    }

    const toolExecutor = options.toolExecutor;
    const messageCtx = options.messageContext || { from: userPhone, text: message };

    const vercelTools = {};
    for (const t of rawTools) {
      const fn = t.function;
      if (!fn?.name) continue;
      vercelTools[fn.name] = tool({
        description: fn.description || `Invoke ${fn.name}`,
        // inputSchema wraps JSON Schema so the SDK validates args before execute
        inputSchema: jsonSchema(fn.parameters || { type: 'object', properties: {} }),
        execute: async (args) => {
          const intentType = getIntentForTool(fn.name);
          try {
            const result = await toolExecutor(intentType, args || {}, messageCtx, context);
            // Return a compact string for the LLM to reason about. If the
            // handler returned a long formatted message, truncate for token
            // sanity — the user still sees the original via side-channel if
            // the handler already sent one.
            const str = typeof result === 'string' ? result : JSON.stringify(result);
            return str.length > 4000 ? str.slice(0, 4000) + '…(truncated)' : str;
          } catch (err) {
            logger.warn(`[AgenticChat] Tool ${fn.name} execute error: ${err.message}`);
            return `Error calling ${fn.name}: ${err.message}`;
          }
        },
      });
    }

    // ── Pick the right model tier via the router ──
    // Casual chat → fast model, complex reasoning → thinking model if configured,
    // everything else → default. Keeps cost sane while delivering better quality
    // on the hard queries.
    const modelRouter = require('./model-router.service');
    const routed = modelRouter.route(message, { purpose: 'chat' });
    logger.info(`[AgenticChat] Model routed: ${routed.tier}=${routed.model} (${routed.reason})`);

    // ── Run the agentic loop ──
    const started = Date.now();
    const maxSteps = parseInt(process.env.AGENTIC_MAX_STEPS || '8', 10);
    const timeoutMs = parseInt(process.env.AGENTIC_TIMEOUT_MS || '45000', 10);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Agentic loop exceeded ${timeoutMs}ms`)), timeoutMs)
    );

    // Use the active provider (Gemini by default). `routed.model` is the slot
    // hint from upstream model routing (default|fast|complex) — if it's an
    // explicit provider-specific model name (legacy), pass it through unchanged.
    const agenticModel = (routed.model === llm.defaultModel() || routed.model === llm.fastModel())
      ? llm.sdkModel(routed.model === llm.fastModel() ? 'fast' : 'default')
      : (() => {
          // Legacy path — explicit model name override. Fall back to default slot.
          logger.warn(`[AgenticChat] Unknown routed model '${routed.model}', using provider default`);
          return llm.sdkModel('default');
        })();

    const loopPromise = generateText({
      model: agenticModel,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: message },
      ],
      tools: vercelTools,
      stopWhen: stepCountIs(maxSteps),
      // Slightly higher temperature for more natural final replies
      temperature: 0.6,
    });

    let result;
    try {
      result = await Promise.race([loopPromise, timeoutPromise]);
    } catch (raceErr) {
      logger.warn(`[AgenticChat] ${raceErr.message}`);
      throw raceErr; // caller falls back to plain chat
    }

    const elapsed = Date.now() - started;
    const stepCount = result.steps?.length || 0;
    const toolCallCount = (result.steps || []).reduce(
      (n, s) => n + (s.toolCalls?.length || 0),
      0
    );
    logger.info(
      `[AgenticChat] ${userPhone}: ${stepCount} step(s), ${toolCallCount} tool call(s), ${elapsed}ms`
    );

    const finalText = result.text || '(no reply)';

    // ── Save both sides of the conversation (same as plain chat path) ──
    await this.saveMessage(userPhone, 'user', message);
    await this.saveMessage(userPhone, 'assistant', finalText);

    // Auto-write to Mem0 (fire-and-forget, same semantics as plain chat)
    try {
      const mem0Service = require('./mem0-memory.service');
      if (mem0Service.isAvailable && mem0Service.isAvailable()) {
        mem0Service
          .add(
            [
              { role: 'user', content: message },
              { role: 'assistant', content: finalText },
            ],
            userPhone,
            { source: 'agentic_chat', ts: Date.now() }
          )
          .catch(e => logger.warn('[AgenticChat] Mem0 add failed: ' + e.message));
      }
    } catch (_) { /* never break on memory bookkeeping */ }

    return finalText;
  }

  // ========== SMARTER SYSTEM PROMPT ==========

  buildSystemPrompt(context = {}, historyLength = 0) {
    // ⚡ Phase 1 optimization: Gemini implicit caching requires an IDENTICAL prefix
    // across calls. We pull `${now}` and `${historyLength}` OUT of the static
    // rules block and move them to the END of this method so the first ~10K tokens
    // become cacheable. 90% discount on cached tokens once warm.
    // See: https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/

    let prompt = `You are Ari — a personal WhatsApp AI assistant. You're that one friend everyone wishes they had — the one who remembers everything, never judges, always has your back, and somehow makes even boring tasks feel easy. You're warm, witty, and genuinely care about making the user's day better.

★★ ANTI-HALLUCINATION RULE — STRICTLY ENFORCED ★★
You are in CHAT mode right now. That means NO action tool was called this turn. Therefore:
- NEVER claim you assigned a task, created a reminder, sent an email, scheduled a meeting, set a follow-up, saved a contact, added a note, or completed ANY action — because none of that happened in this turn.
- If the user's message looks like it's continuing a previous request (e.g. they replied to a clarifying question you asked), say something like: "Hold on — let me actually run that. Could you say it again as a single line, like 'assign task X to Y'?" Do NOT pretend you executed it.
- CAPABILITY HONESTY: if the user is clearly asking for an ACTION and their phrasing is already a clear command (they named the thing and what to do with it), do NOT ask them to rephrase — rephrasing will not help. Say plainly that you can't do that specific action from chat yet, and if it's a CRM/dashboard feature, point them to the right dashboard section (e.g. Contacts → Groups). Asking the user to repeat a clear command that already failed once is the worst possible reply.
- If you're unsure whether an action ran, say so honestly: "I'm not sure if that went through — try saying it again as a clear command."
- NEVER use past-tense action verbs (assigned, created, sent, scheduled, set, saved, added, deleted, completed, booked, cancelled) in a way that implies YOU performed the action this turn.
- It's always better to ask the user to retry a command than to fake a success.

★★ TEMPLATE-FILLING RULE — STRICTLY ENFORCED ★★
When you show the user an example command (e.g. "say it like 'Remind X: TITLE at TIME'"):
- NEVER fill in TITLE, X, Y, TIME or any placeholder with a value the user did NOT just state in their CURRENT message.
- Do NOT pull titles, names, times, or content from earlier in the conversation OR from any "pending draft" state — that is hallucination.
- The example must use literal placeholders ("[task name]", "[time]") OR exact values the user just typed in this exact turn. Nothing else.
- If you don't have a value, leave the placeholder unfilled or ask: "What should the reminder say?" / "What time?"
- Concrete: if the user just typed "change time to 2pm" with no other content, your example MUST read 'Remind [name]: [task] at 2pm' — NOT a fabricated task title.

YOUR IDENTITY:
- Your name is Ari
- When someone asks “what's your name”, “your name”, “who are you”, “what are you” — they are asking about YOU (the assistant), NOT about the user. NEVER respond with the user's name. Always introduce yourself naturally: “Hey, I'm Ari! Think of me as your personal assistant who never sleeps, never forgets, and always has your back.”
- IMPORTANT: “your name” in a question means THE ASSISTANT'S name, not the user's stored name
- You can refer to yourself as Ari naturally in conversation when it fits

CONVERSATION MEMORY:
- You have access to recent conversation history — count the messages yourself if needed
- ALWAYS use the history to understand context, references like “it”, “that”, “earlier”, “there”, “this”
- If user refers to something discussed before, recall it naturally
- Remember names, preferences, and topics from earlier in the conversation
- CRITICAL: When user asks a follow-up question using words like “there”, “that”, “it”, “they” — ALWAYS check recent messages to understand what they're referring to. For example, if you just discussed Iran and user asks “did someone die there?”, “there” means Iran, NOT the user's location. Never assume a follow-up is about the user personally when a topic was just discussed

RESPONSE STYLE:
- Talk like a real person texting on WhatsApp — not a corporate chatbot
- Keep responses SHORT (1-3 lines for simple responses, max 5-6 for complex ones) — this is WhatsApp, not email
- NEVER write essays. If you catch yourself writing more than 8 lines, cut it down
- Understand WhatsApp abbreviations/slang naturally — NEVER ask “what do you mean by X?”, just interpret them (e.g., imp=important, msg=message, pls=please, tmr=tomorrow, rn=right now, lol, omg, brb, idk, lmk, fyi, asap, tbh, ngl, wyd, hru, etc.)
- Use natural, conversational language — contractions, casual phrasing, the way friends actually text
- Be witty, encouraging, or empathetic as the situation calls for — read the room
- Show personality — it's okay to joke around, tease lightly, celebrate wins, or be comforting when needed
- NEVER use emojis in your responses. No emoji at all — keep it clean text only
- If someone asks inappropriate/harmful questions, politely decline and redirect to how you can help them productively

TONE MIRRORING (IMPORTANT):
- Match the user's formality level. If they write “bro check my inbox”, be casual. If they write “Could you please check my email”, be more polished
- If user sends short clipped messages, keep your responses equally brief
- If user writes in full sentences with detail, you can be more thorough
- If user seems stressed or urgent, skip the banter — be direct and helpful
- If user is excited or happy, match their energy

BANNED WORDS/PHRASES (these sound robotic — NEVER use them):
Words: delve, tapestry, landscape, navigate, leverage, utilize, embark, unlock, unveil, elevate, foster, beacon, robust, cutting-edge, realm, crucial, comprehensive, meticulous, intricate, pivotal, nuanced, synergy, streamline, holistic, paradigm, transformative, supercharge, testament, trajectory, cornerstone, spearhead, groundbreaking
Phrases: “In today's fast-paced world”, “It's important to note”, “Let me break this down”, “Here's the thing”, “At the end of the day”, “I'd be happy to help”, “Great question!”, “That's a great point”, “dive into”, “deep dive”, “game-changer”, “circle back”, “move the needle”, “double down”, “unpack this”

NEVER DO THESE:
- Never start with “Absolutely!” or “Of course!” or “Certainly!” — these are AI tells
- Never repeat the user's question back to them before answering
- Never say “I understand your concern” or “That's a valid point”
- Never use “Here's what you need to know:” followed by bullets unless user asked for a list
- Never start consecutive responses the same way
- Don't over-acknowledge — just answer the question
- When confirming an action, be brief: “Done, reminder set for 3pm tomorrow” NOT “I have successfully saved your reminder for 3:00 PM tomorrow. You will be notified at the scheduled time.”

CONVERSATIONAL TEXTURE:
- Vary sentence length — mix short punchy ones with longer ones
- It's okay to start with “And” or “But” like people actually do
- Use casual transitions: “oh and”, “btw”, “also”, “so basically”
- Don't be perfectly structured — real people don't organize every thought into bullet points
- When confirming actions, be concise: “Saved!” or “Reminder set for 3pm” — not a paragraph

WHATSAPP RESPONSE LENGTH:
- Greeting/simple question: 1 line
- Confirming an action: 1 line (“Done, reminder set for 5pm”)
- Simple factual answer: 1-2 lines
- Explaining something: 3-5 lines max
- Only go beyond 5 lines for: complex explanations the user asked for, or listing multiple items

LANGUAGE (CRITICAL):
- You are multilingual and can speak 100+ languages fluently
- ALWAYS reply in the SAME language the user's CURRENT message is written in
- If user sends a message in Spanish, reply in Spanish. If next message is in English, switch to English. If next is in Japanese, switch to Japanese. Match EVERY message's language individually.
- For Hinglish (Hindi + English mix in Latin script), reply naturally in Hinglish the way Indians text on WhatsApp
- NEVER ask “which language do you prefer?” — just match whatever they write in
- This applies per-message: if someone chats in English for 10 messages then sends 1 message in French, reply to THAT message in French. If they switch back to English, switch back too.
- Keep formatting markers (*bold*, dates, numbers, URLs) as-is regardless of language
ANTI-HALLUCINATION (CRITICAL):
- NEVER make up, fabricate, or guess information you don't have — this includes phone numbers, dates, facts, prices, scores, or anything the user shared previously
- If user asks for something they supposedly told you before (a number, a name, a detail) and you don't see it in the conversation history or memory context below — say honestly: "I don't have that saved. Could you share it again?"
- NEVER say "I've sent it" or "here it is" if you don't actually have the data to share
- NEVER pretend you did something you didn't (like sending a number, forwarding a message, etc.)
- If you're unsure about current events (news, weather, scores), say you'd need to search rather than guessing
- When in doubt, say "I don't have that" rather than making something up

CRITICAL PRIVACY RULE:
- ALWAYS hide phone numbers and sensitive data in casual conversation
- ONLY share phone numbers if user EXPLICITLY asks "What is [Person]'s number?"
- Example: "Do you know Danish?" â†’ "Yes, I know Danish." (No number!)

CORE SKILLS (DO NOT DENY THESE â€” when user asks "what can you do" or "help", list these clearly):

Reminders & Scheduling:
- Set one-time, recurring (daily/weekdays/weekends/custom days), or batch reminders
- Send reminders to saved contacts by name

Memory & Notes:
- Save and recall personal info, facts, passwords, preferences
- Save/view/search/delete notes under topics

Contacts:
- Save, view, update, delete contacts (name + phone)

Lists:
- Create and manage lists (shopping, todo, etc.)

Email (Gmail):
- Send AI-drafted emails with edit/revise before sending
- Schedule emails for a future date/time
- Bulk email â€” send same email to multiple recipients individually
- Email meeting attendees

Sales Assistant:
- Add/view/update/delete sales leads with pipeline tracking
- Lead stages: new, contacted, replied, meeting, proposal, negotiation, won, lost
- Sales email templates: cold outreach, follow-up, proposal, meeting request, thank you, check-in, closing
- Check lead replies, set follow-up dates, add notes, view pipeline summary

Calendar:
- Book/cancel/view meetings (Google, Outlook, Apple)
- Check availability, meeting reminders, list connected calendars

Google Workspace:
- Search Google Drive, read/create/summarize Google Docs, read/summarize Google Sheets

Team & Productivity:
- Task management (add, view, complete, assign to team)
- Team members, leave management, standups, polls
- Scheduled messages, team availability, daily briefing

Utilities:
- Web search (weather, news, scores, stocks, current events)
- Image and document analysis (send photo/PDF)
- Translate text to any language
- Conversation summary, export data, clear chat history

BEHAVIOR RULES:
- If a user asks vaguely (e.g. "Remind Emily"), guide them: "Sure! When should I remind them? E.g., 'Remind Emily to call me in 30 minutes'"
- If someone says "save this number as X" with a phone number, save it as a contact`;

    // Reinforce per-message language matching with detected language
    if (context.userLanguage && context.userLanguage.code !== 'en') {
      const langCode = context.userLanguage.code;
      const langName = context.userLanguage.name;
      if (langCode === 'hi-Latn' || langCode === 'hi') {
        prompt += `\n\nCURRENT MESSAGE LANGUAGE: ${langName}. Reply in Hinglish naturally — mix Hindi and English the way Indians text on WhatsApp.`;
      } else {
        prompt += `\n\nCURRENT MESSAGE LANGUAGE: ${langName} (${langCode}). Reply in ${langName} directly — do NOT write in English and translate. Think and respond natively in ${langName}.`;
      }
    }

    // Helper to truncate context sections to prevent token overflow
    const cap = (text, max = 1500) => text && text.length > max ? text.slice(0, max) + '...' : text;

    // Add user memories as context
    if (context.userInfo) {
      prompt += `\n\nKNOWN FACTS ABOUT THIS USER (from memory trunk):\n${cap(context.userInfo, 2000)}\n\nUse these facts naturally when relevant. If they ask about something you already know, answer directly instead of asking again. Don't recite all memories unprompted. IMPORTANT: If the user asks about something NOT listed here, say you don't have it — never make it up.`;
    }

    // Add pending reminders
    if (context.remindersInfo) {
      prompt += `\n\nUSER'S PENDING REMINDERS: ${context.remindersInfo}\nMention these if the user asks about their schedule or reminders.`;
    }

    // Add active lists
    if (context.listsInfo) {
      prompt += `\n\nUSER'S LISTS: ${context.listsInfo}\nReference these if the user asks about their lists or things to do.`;
    }

    // Add saved contacts
    if (context.contactsInfo) {
      prompt += `\n\nUSER'S SAVED CONTACTS: ${cap(context.contactsInfo, 1000)}\nYou can see contact names above but NOT their phone numbers. If the user asks for a contact's phone number, respond EXACTLY with: "CONTACT_LOOKUP:name" where name is the contact name (e.g., "CONTACT_LOOKUP:neha"). The system will replace this with the actual number. NEVER fabricate or guess a phone number.`;
    }
    if (context.recentContactInfo) {
      prompt += `\n${context.recentContactInfo} â€” if user says "the person I just saved" or "last saved contact", this is who they mean.`;
    }

    // Add Google Calendar context
    if (context.googleConnected) {
      if (context.calendarInfo) {
        prompt += `\n\nGOOGLE CALENDAR (connected):\n${context.calendarInfo}\nUser can book, cancel, or view meetings.`;
      } else {
        prompt += `\n\nGOOGLE CALENDAR: Connected. User can book, cancel, or view meetings.`;
      }
    } else {
      prompt += `\n\nGOOGLE CALENDAR: Not connected. If user asks about calendar/meetings, suggest: "Say 'connect google' to link your Google account."`;
    }

    // Add tasks context
    if (context.tasksInfo) {
      prompt += `\n\nUSER'S TASKS: ${context.tasksInfo}\nReference these if the user asks about their tasks or to-do items.`;
    }

    // Add notes context
    if (context.notesInfo) {
      prompt += `\n\nUSER'S NOTE TOPICS: ${context.notesInfo}\nMention these if the user asks about their notes or saved information.`;
    }

    if (context.salesInfo) {
      prompt += `\n\nSALES PIPELINE: ${context.salesInfo}\nUser can manage leads, send sales emails, check replies. Commands: "new lead...", "my leads", "follow up with...", "sales summary", "lead replies"`;
    }

    if (context.imageContext) {
      prompt += `\n\nRecently analyzed image: ${cap(context.imageContext, 1000)}`;
    }

    // ⚡ Phase 1 optimization: Append per-call dynamics LAST so the cacheable
    // static prefix (~10K tokens of rules above) stays byte-identical across
    // every call → triggers Gemini implicit caching (90% off cached tokens).
    const now = new Date().toLocaleString('en-IN', {
      timeZone: context.userTimezone || 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    prompt += `\n\nDYNAMIC CONTEXT (per-call):\n- Current time: ${now}\n- Conversation history available: ${historyLength} messages`;

    // Closing reinforcement — placed AFTER all dynamic context so it's the
    // last thing the LLM reads before the user message (recency bias).
    // The TEMPLATE-FILLING RULE near the top of this prompt is otherwise
    // buried under ~1000 tokens of identity/style rules and gets ignored.
    // This already-cached static suffix is the same on every call.
    prompt += `\n\n★ FINAL REMINDER — TEMPLATE-FILLING RULE ★\nIf you show an Example: line, fill placeholders ONLY with values the user typed in their CURRENT message. Otherwise leave them as [task], [name], [time]. Do NOT pull values from earlier messages, drafts, or memory — that produces hallucinations.`;

    return prompt;
  }

  // ========== CHAT WITH SEARCH RESULTS ==========

  async chatWithSearch(userPhone, message, searchResults, context = {}) {
    // Cap individual snippet length AND total snippet payload to keep the
    // prompt well under the LLM's input window for any provider. Without this,
    // long news results (multi-paragraph snippets) sometimes pushed the
    // request over budget on Haiku/Bedrock and surfaced as the generic
    // "Couldn't process that" error to users.
    const TRIMMED_SNIPPET_LEN = 280;
    const MAX_RESULTS_FOR_PROMPT = 6;
    const safeResults = (searchResults || []).slice(0, MAX_RESULTS_FOR_PROMPT).map(r => ({
      title: (r.title || '').slice(0, 200),
      snippet: (r.snippet || r.content || '').slice(0, TRIMMED_SNIPPET_LEN),
      url: r.url || ''
    }));

    try {
      const history = await this.getHistoryWithSummarization(userPhone);

      const systemPrompt = this.buildSystemPrompt(context, history.length) + `

SEARCH RESULTS (use these to answer):
${safeResults.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet}`).join('\n')}

Answer naturally using this info. Don't list all results -- synthesize into a conversational response.
IMPORTANT: Cryptocurrency prices (Bitcoin, Ethereum, etc.) are ALWAYS expressed in USD (e.g. "$72,000 USD"). Never confuse Bitcoin/crypto prices with currency exchange rates. A forex rate like USD/INR (e.g. 92.5) is completely different from a Bitcoin price (tens of thousands of dollars). If asked for both in one message, give separate clear answers for each.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
      ];

      // Bedrock-aware. Was failing with "Unsupported protocol bedrock:" because
      // axios.post(this.apiUrl) hits the 'bedrock://converse' sentinel — same
      // Bedrock-routing bug fixed elsewhere. THIS is the function that
      // surfaced the "Couldn't process that. Try again?" error to users when
      // they searched (visa, web, etc).
      const response = await llm.chatCompletion({
        model: this.model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000
      }, { timeout: 15000 });

      const aiResponse = response.data.choices[0].message.content;

      await this.saveMessage(userPhone, 'user', message);
      await this.saveMessage(userPhone, 'assistant', aiResponse);

      return aiResponse;

    } catch (error) {
      // N2 fix (Apr 2026): Don't bail to a generic "try again" — that's a
      // dead-end UX. If the LLM summarization fails (rate limit, content
      // filter, oversized payload), at least surface the top search results
      // verbatim so the user gets SOMETHING actionable.
      logger.error(`[chatWithSearch] LLM failed for "${message.slice(0, 80)}": ${error.message}`, {
        status: error.response?.status,
        data: error.response?.data,
      });

      if (safeResults.length === 0) {
        return "I searched but couldn't get results — try rephrasing or ask again in a moment.";
      }

      // Fallback: format raw results into a clean WhatsApp-friendly summary.
      let fallback = `Here's what I found:\n\n`;
      safeResults.slice(0, 4).forEach((r, i) => {
        const title = r.title || `Result ${i + 1}`;
        const snippet = r.snippet ? r.snippet.slice(0, 200) : '';
        fallback += `*${i + 1}. ${title}*\n${snippet}${r.url ? `\n${r.url}` : ''}\n\n`;
      });
      fallback += `_(Direct results — my AI summary failed but the search worked.)_`;
      return fallback.trim();
    }
  }

  // ========== GET RECENT CONTEXT (for other services) ==========

  async getRecentContext(userPhone, messageCount = 10, opts = {}) {
    // Hard time-window cap. Without this, the LLM sees messages from
    // days or weeks ago and occasionally pulls stray text from them
    // into tool parameters (e.g. grabbing yesterday's bug-report phrase
    // as a new reminder message). 30 minutes covers any normal
    // conversation thread; anything older is a fresh thread.
    const maxAgeMinutes = Number.isFinite(opts.maxAgeMinutes) ? opts.maxAgeMinutes : 30;

    try {
      const session = currentChatSession();
      const result = session?.sessionId
        ? await query(
          `SELECT role, content FROM conversation_history
            WHERE user_phone = $1 AND session_id = $2::uuid
            ORDER BY created_at DESC
            LIMIT $3`,
          [userPhone, session.sessionId, messageCount]
        )
        : await query(
          `SELECT role, content FROM conversation_history
           WHERE user_phone = $1
             AND session_id IS NULL
             AND created_at > NOW() - make_interval(mins => $3::int)
           ORDER BY created_at DESC
           LIMIT $2`,
          [userPhone, messageCount, maxAgeMinutes]
        );

      return result.rows.reverse(); // Return in chronological order
    } catch (error) {
      return [];
    }
  }

  // Extract mentioned locations from recent conversation
  async getRecentLocation(userPhone) {
    try {
      const recent = await this.getRecentContext(userPhone, 10);

      const locationPatterns = [
        /(?:in|at|to|from|moving to|going to|living in|based in)\s+([a-zA-Z][a-zA-Z]+(?:\s+[a-zA-Z][a-zA-Z]+)?)/gi,
        /(?:time|weather)\s+(?:in|at|for)\s+([a-zA-Z][a-zA-Z]+(?:\s+[a-zA-Z][a-zA-Z]+)?)/gi,
        /([a-zA-Z][a-zA-Z]+(?:\s+[a-zA-Z][a-zA-Z]+)?)\s+(?:time|weather)/gi
      ];

      for (const msg of recent.reverse()) { // Most recent first
        for (const pattern of locationPatterns) {
          const matches = msg.content.matchAll(pattern);
          for (const match of matches) {
            const location = match[1]?.trim();
            if (location && location.length > 2) {
              return location;
            }
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // ========== AI-POWERED INTENT DETECTION (OpenAI Tool Calling) ==========

  /**
   * Semantic fallback router — classifies a message into one of the known
   * tool categories when the regex keyword classifier returns null. Uses a
   * very small, very fast model (Ministral 3 3B by default) so the added
   * latency is ~80ms. This is what lets non-English + noun-form + implicit
   * intents get routed correctly instead of falling through to the full 78
   * tool set (which degrades pick accuracy).
   *
   * Returns a category name from TOOL_CATEGORY values, or null if the model
   * thinks it's pure chit-chat / no tool applies.
   */
  async _classifyCategorySemantic(message) {
    if (!message) return null;

    // NOTE: keep this list in sync with the categories in
    // tool-definitions.js TOOL_CATEGORY. 'visa' was removed Apr 30 2026
    // along with the visa feature — returning it produced an EMPTY category
    // subset (essentials + padding only), which silently hid the right tool
    // from the intent LLM.
    const CATEGORIES = [
      'reminder', 'calendar', 'meeting', 'email', 'task', 'team',
      'memory', 'notes', 'google', 'search', 'briefing', 'contact',
      'sales', 'image', 'productivity', 'account', 'delegation'
    ];

    const prompt = `Classify this WhatsApp message into ONE category. Reply with just the category name (lowercase, no punctuation, no explanation).

Categories: ${CATEGORIES.join(', ')}, or "chat" if it's just small talk.

Examples across languages:
"remind me to call mom at 3pm" → reminder
"मुझे कल 3 बजे याद दिलाना" → reminder
"subah 6 baje gym" → reminder
"rappelle-moi demain" → reminder
"doctor at 11 tomorrow" → reminder
"erinnere mich um 18 Uhr" → reminder
"book lunch with priya 1pm" → calendar
"what's on my calendar" → calendar
"am I free tomorrow at 3" → calendar
"draft an email to priya" → email
"check my inbox" → email
"priya ko email karo" → email
"what's on my plate today" → briefing
"aaj kya hai schedule mein" → briefing
"brief me" → briefing
"save my wifi password is abc" → memory
"what's my flight number" → memory
"send all" → chat
"the first one" → chat
"ya do it" → chat
"tell rahul meeting moved" → delegation
"message the team" → delegation
"add task finish report" → task
"log my water intake" → productivity
"note that john likes tea" → notes
"save rohan's number as +91..." → contact
"hi how are you" → chat
"what do you think about life" → chat
"thanks" → chat

Message: "${String(message).slice(0, 400)}"
Category:`;

    try {
      const llm = require('./llm-provider');
      const started = Date.now();
      const modelForRouter = process.env.MODEL_ROUTER_CLASSIFIER || 'ministral-3-3b';
      const resp = await llm.chatCompletion({
        model: modelForRouter,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0
      }, { timeout: 4000 });
      const latencyMs = Date.now() - started;

      // Extract the first word from the response, stripped of punctuation.
      const raw = String(resp?.data?.choices?.[0]?.message?.content || '')
        .trim()
        .toLowerCase()
        .replace(/["'`.,!?:;\[\]()]/g, '')
        .split(/\s+/)[0];

      const KNOWN = new Set(CATEGORIES);
      if (KNOWN.has(raw)) {
        logger.debug(`[SemanticRouter] ${latencyMs}ms → ${raw}`);
        return raw;
      }
      // "chat" or unrecognized → treat as no category (no tool subsetting)
      logger.debug(`[SemanticRouter] ${latencyMs}ms → "${raw}" (treated as chat/none)`);
      return null;
    } catch (e) {
      logger.debug(`[SemanticRouter] failed: ${e.message} — falling back to full tool set`);
      return null;
    }
  }

  /**
   * Detect user intent using OpenAI function/tool calling.
   * The LLM selects the appropriate tool AND extracts parameters in one call.
   * Returns { type, params } or null for general chat.
   */
  async detectIntent(message, options = {}) {
    const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : [];

    // Ultra-short replies ("1", "2", "ok", "ya") are only noise when there is
    // no conversation to anchor them. WITH recent context — history OR an
    // outstanding clarification question — they are usually list selections
    // or answers, and must reach the LLM to be resolved. Dropping them here
    // was a direct cause of "replied '2' to a list and the bot started small
    // talk".
    const hasPendingClarification = !!(options.contextHints && options.contextHints.pendingIntentClarification);
    if (String(message).trim().length === 0) return null;
    if (message.length <= 2 && recentMessages.length === 0 && !hasPendingClarification) return null;

    // Check AI call budget — if exhausted, skip intent detection (falls through to chat which also checks)
    if (options.userPhone && isAiCallLimited(options.userPhone)) {
      return null; // Fall through — chat() will return the rate limit message
    }

    // ⚡ Phase 3: Embedding fast path — skip LLM intent classification entirely
    // for high-confidence canonical queries (e.g. "show my tasks", "dashboard",
    // "my reminders"). Replaces a ~$0.002 LLM call with a ~50ms embedding lookup.
    // Disabled by default — activate via OPT_EMBEDDING_FAST_PATH=true.
    if (process.env.OPT_EMBEDDING_FAST_PATH === 'true') {
      try {
        const fastpath = require('./intent-fastpath.service');
        const fpResult = await fastpath.classify(message);
        if (fpResult) {
          const { getIntentForTool } = require('./tool-definitions');
          const intentType = getIntentForTool(fpResult.toolName);
          logger.info(`[Intent] FastPath hit: ${fpResult.toolName} -> ${intentType} (conf=${fpResult.confidence.toFixed(3)})`);
          return {
            type: intentType,
            params: { ...fpResult.params, full_text: message },
            toolName: fpResult.toolName,
            _fastpath: true,
          };
        }
      } catch (e) {
        // Never break intent detection on fast-path failure — fall through to LLM.
        logger.warn(`[Intent] FastPath errored, falling through to LLM: ${e.message}`);
      }
    }

    // Truncate long messages for intent detection instead of skipping entirely
    const intentMessage = message.length > 1000 ? message.slice(0, 1000) : message;

    try {
      const { getToolDefinitions, getIntentForTool, getExplicitToolHint } = require('./tool-definitions');
      const contextHints = options.contextHints || {};
      const explicitToolHint = getExplicitToolHint(intentMessage, contextHints);
      // Keep message-derived commands separate from workflow-derived hints.
      // The latter are advisory when several workflows overlap; the provider
      // may correctly select a different active continuation.
      const explicitMessageToolHint = getExplicitToolHint(intentMessage, {});

      // Tool subsetting — multi-tier with the strongest method first:
      //   Tier 0 (Phase 4, ~150ms): RAG-MCP semantic retrieval — embed user msg
      //          and pull top-K=8 most-similar tool descriptions out of all 96.
      //          Catches Hindi/Hinglish/Arabic/paraphrases regex can't. Drops
      //          ~10K tokens per intent call. Source: arxiv 2505.03275.
      //   Tier 1 (0ms): regex classifier — catches English + common Hinglish
      //   Tier 2 (~80ms): Ministral 3B semantic classifier when regex whiffs
      //          — handles pure Devanagari/Arabic/German/Chinese + noun-form
      //   Tier 3: full 96-tool set (final safety net)
      let tools;
      let classifiedCategory = null;
      let usedToolSubset = false; // true when the LLM saw fewer than all tools

      // Short follow-ups ("ya do it", "the 2nd one", "cancel that", "usko
      // change karo") carry no reliable category keywords — the CONVERSATION
      // decides what they mean, not the words. Keyword/embedding subsetting
      // on such messages is noise and routinely hides the correct tool, so
      // give the LLM the full menu and let history do the disambiguation.
      const shortFollowUpMaxLen = parseInt(process.env.INTENT_SHORT_FOLLOWUP_LEN || '25', 10);
      const isShortFollowUp = intentMessage.trim().length <= shortFollowUpMaxLen && recentMessages.length > 0;

      // Tier 0: RAG-MCP semantic retrieval (preferred when enabled)
      if (!isShortFollowUp && process.env.OPT_RAG_MCP_ENABLED === 'true') {
        try {
          const retriever = require('./tool-retriever.service');
          const ragResult = await retriever.retrieve(intentMessage);
          if (ragResult && Array.isArray(ragResult.tools) && ragResult.tools.length > 0) {
            tools = ragResult.tools;
            usedToolSubset = true;
            logger.info(`[Intent] RAG-MCP retrieved ${tools.length} tools (topScore=${ragResult.topScore.toFixed(3)})`);
          }
        } catch (e) {
          // Never block intent detection on retriever errors — fall through.
          logger.warn(`[Intent] RAG-MCP failed, falling through to keyword subsetting: ${e.message}`);
        }
      }

      // Tier 1+2+3: Existing keyword/semantic-classifier subsetting (used when
      // RAG-MCP is disabled OR returned no tools).
      if (!tools && !isShortFollowUp && process.env.TOOL_SUBSETTING_ENABLED !== 'false') {
        const { classifyCategoryFromKeywords, getToolsForCategory } = require('./tool-definitions');

        // Fast path — regex keyword match
        classifiedCategory = classifyCategoryFromKeywords(intentMessage);

        // Slow path — semantic classifier only kicks in when fast path returns null
        if (!classifiedCategory && process.env.SEMANTIC_ROUTER_ENABLED !== 'false') {
          classifiedCategory = await this._classifyCategorySemantic(intentMessage);
          if (classifiedCategory) {
            logger.info(`[Intent] Semantic router classified as: ${classifiedCategory}`);
          }
        }

        if (classifiedCategory) {
          const subsetLimit = parseInt(process.env.TOOL_SUBSET_LIMIT || '24', 10);
          tools = getToolsForCategory(classifiedCategory, subsetLimit);
          usedToolSubset = true;
          logger.info(`[Intent] Tool subset: category=${classifiedCategory}, count=${tools.length}`);
        } else {
          tools = getToolDefinitions();
          logger.info(`[Intent] No category matched — using full tool set (count=${tools.length})`);
        }
      } else if (!tools) {
        if (isShortFollowUp) {
          // A short follow-up has no keywords of its own, but the resolved
          // positional selection or the recent conversation usually does.
          // The full 86-tool menu is the LAST resort — a bare "1" against
          // every tool is exactly how manage_images captured email/task
          // selections (smoke-test H-1).
          const { classifyCategoryFromKeywords, getToolsForCategory } = require('./tool-definitions');
          const historyText = recentMessages.slice(-6).map((m) => m?.content || '').filter(Boolean).join('\n');
          const historyCategory = classifyCategoryFromKeywords(historyText);
          if (historyCategory) {
            const subsetLimit = parseInt(process.env.TOOL_SUBSET_LIMIT || '24', 10);
            tools = getToolsForCategory(historyCategory, subsetLimit);
            usedToolSubset = true;
            logger.info(`[Intent] Short follow-up subset from history: category=${historyCategory}, count=${tools.length}`);
          } else {
            tools = getToolDefinitions();
            logger.info(`[Intent] Short follow-up with history — no category signal, using full tool set`);
          }
          // A deterministic positional resolution pins the list's own tools
          // into the visible set regardless of which subset was chosen.
          const positionalList = options.contextHints?.positionalSelection?.listType;
          if (positionalList) {
            const POSITIONAL_TOOLS = {
              reminders: ['cancel_reminder', 'update_reminder', 'view_reminders'],
              tasks: ['manage_tasks'],
              google_tasks: ['manage_google_tasks'],
              images: ['manage_images'],
              incidents: ['manage_incidents'],
              leads: ['manage_sales'],
              sales: ['manage_sales'],
              contacts: ['manage_contacts'],
              groups: ['manage_contact_groups'],
              notes: ['manage_notes'],
            };
            const all = getToolDefinitions();
            for (const name of POSITIONAL_TOOLS[positionalList] || []) {
              if (!tools.some((tool) => tool.function.name === name)) {
                const definition = all.find((tool) => tool.function.name === name);
                if (definition) tools.push(definition);
              }
            }
          }
        } else {
          tools = getToolDefinitions();
        }
      }

      if (explicitToolHint) {
        const allTools = getToolDefinitions();
        const hintedDefinition = allTools.find(tool => tool.function.name === explicitToolHint);
        if (hintedDefinition && !tools.some(tool => tool.function.name === explicitToolHint)) {
          tools = [hintedDefinition, ...tools.slice(0, Math.max(0, tools.length - 1))];
          usedToolSubset = true;
        }
        logger.info(`[Intent] Explicit tool hint: ${explicitToolHint}`);
      }

      const workflowHintsText = this.formatIntentContextHints(contextHints);

      // A bare positional/affirmation token with ZERO context is unresolvable
      // by definition — don't even ask the LLM. Weak intent models grab
      // view_dashboard for a bare "all" because the word appears in its enum
      // (prompt vetoes alone don't reliably stop this). No history + no
      // active workflow → general chat, which will ask what the user means.
      const barePositional = /^(all|first|second|third|last|yes|yeah|ok|okay|#?\d{1,2}|option\s+\d{1,2}|the\s+\w+\s+one)[\s.!?]*$/i;
      if (barePositional.test(intentMessage.trim())
          && recentMessages.length === 0
          && workflowHintsText === 'No special active workflow state.') {
        logger.info(`[Intent] Bare positional reply "${intentMessage.trim().slice(0, 20)}" with no context — no tool routing`);
        return null;
      }

      // Build conversation context for the LLM (25 msgs; user turns 500 chars,
      // assistant turns 1500 so numbered lists/option menus survive whole)
      const contextMessages = recentMessages
        .slice(-this.intentRecentMessages)
        .map(msg => {
          const isAssistant = msg.role === 'assistant';
          return {
            role: isAssistant ? 'assistant' : 'user',
            content: String(msg.content || '').slice(
              0,
              isAssistant ? this.intentContextTruncateAssistant : this.intentContextTruncate
            )
          };
        });

      // Prompt versions: v3 (default) = intent-first + clarification policy;
      // v2 = compact keyword-rule prompt; v1 = original keyword-rule prompt.
      // Roll back with INTENT_PROMPT_VERSION=v1 or v2.
      const intentPromptVersion = process.env.INTENT_PROMPT_VERSION || 'v3';
      const systemPrompt = (intentPromptVersion === 'v3')
        ? this._buildIntentSystemPromptV3(workflowHintsText)
        : (intentPromptVersion === 'v2')
        ? this._buildIntentSystemPromptV2(workflowHintsText)
        : `You are an intent detection system for a WhatsApp AI assistant called Ari. Your job is to decide if the user's message requires a specific action (call the appropriate tool) or is just casual conversation (don't call any tool).

RULES:
- Understand the FULL message meaning in ANY language (English, Hindi, Hinglish, French, Spanish, German, Arabic, etc.)
- The CURRENT message always takes priority over conversation history. Classify based on what the user is asking RIGHT NOW, not what they asked earlier.
- Use conversation history and active workflow state to resolve ambiguous follow-ups like "yes", "do it", "cancel this", "option 1"
- If the user is just chatting, saying something that doesn't need an action - do NOT call any tool
- EXCEPTION: Questions about real-time or current data MUST use web_search — this includes exchange rates (USD/INR, EUR/USD), crypto prices (Bitcoin, Ethereum, etc.), stock prices, weather, news, sports scores, "what is X today", "current price of X", "latest news on X". Do NOT answer these from training knowledge. NOTE: Bitcoin/crypto prices are in USD (tens of thousands), never confuse them with forex rates.
- If the user says "search the web", "google it", "look up", "find out", or "search for" — ALWAYS use web_search regardless of topic.
- WhatsApp abbreviations: imp=important, msg=message, tmr=tomorrow, pls=please, abt=about, sched=schedule, sv=save
- Common typos: schdule/shedule=schedule, meting=meeting, tomorow=tomorrow
- Hinglish: "yaad dilana"=remind, "baje"=o'clock, "kal"=tomorrow, "subah"=morning, "karo"=do, "bhejna"=send
- Slang words like "bro", "lol", "dude", "yaar" are filler - ignore them for intent detection
- "tell [person]" or "let [person] know" or "send message to [person/team]" or "notify [person/team]" = delegate_message (sending a message), NOT set_reminder
- "tell the team" or "message the team" or "let the team know" = delegate_message with target_name="team"
- "remind [person]" = set_reminder, NOT delegate_message
- "done X" or "completed X" = manage_habits (logging a habit), NOT set_reminder
- "what's on my plate" or "what do I have today" = daily_briefing, NOT set_reminder
- "dashboard" or "show my dashboard" or "my stats" = view_dashboard (ALWAYS, even as a single word)
- "tasks assigned to me", "my assigned tasks", "what tasks do I have from others" = manage_tasks with action=list_assigned_to_me
- "tasks I assigned", "tasks I gave", "tasks I delegated", "show tasks I gave to others" = manage_tasks with action=list_assigned_by_me

ANAPHORA — "that"/"it"/"actually" follow-ups (CRITICAL — Apr 27 2026 hardened):

Resolution priority (apply IN ORDER, stop at first match):
1. Last tool-created entity in the SAME CLASS as the anaphor (note→note, task→task, meeting→meeting, reminder→reminder) within last 6 turns. This is PRIMARY.
2. Last open confirmation gate (calendar booking, task assign, reminder set, note save) if no same-class entity in step 1.
3. Last tool-created entity of ANY class within last 3 turns.
4. Otherwise — DO NOT GUESS. Ask "Which one?" rather than pick wrong.

HARD VETOES (never violate, regardless of recency):
- Anaphors NEVER resolve to web_search results, news articles, Wikipedia pages, product specs, or anything fetched by lookup tools. These are not user-owned entities.
- Anaphors NEVER resolve to entities mentioned only in the bot's own clarifying questions or examples — only to entities the user actually created or actively chose.
- "edit that note"/"update that note" → manage_notes(update); the target is the LAST manage_notes save, NOT an iPhone 17 spec sheet from a recent web_search.
- "actually assign that to <email>" right after a task creation → manage_tasks(assign), NEVER send_email/delegate_message. The email is the new ASSIGNEE.
- "change time to 5pm" / "actually make it 6pm" / "no 7pm instead" right after a meeting/reminder/event create → update THAT in-flight entity, keeping date unless changed. NEVER hijacks a Tokyo time/timezone query as the target.
- "actually make it 3 hours" right after "remind me to call john in 2 hours" → change THAT REMINDER's duration. NEVER reinterpret as Tokyo time difference, timezone offset, or anything from a separate intent.
- "delete that" / "cancel that" → delete same-class entity, NEVER cancel different one.

WHEN UNSURE → ASK. "Which one — the note about the launch, or something else?" is ALWAYS better than guessing wrong.

IMPLICIT INTENT EXAMPLES (trigger tools even WITHOUT explicit keywords):

Reminders (action + time, no word "remind" required):
  "call mahaprasad at 11"          → set_reminder
  "gym tomorrow 6am"                → set_reminder
  "mom's birthday march 15"         → set_reminder
  "pick up kids at 3:30"            → set_reminder
  "take meds at 9"                  → set_reminder
  "pay electricity bill by monday"  → set_reminder
  "flight at 7am tomorrow"          → set_reminder
  "meds rozana 9pm"                 → set_reminder (recurring)

Calendar events (named event + time, often with attendees):
  "dentist 3pm thursday"            → create_calendar_event
  "meet john tuesday 2pm"           → create_calendar_event
  "interview with google friday"    → create_calendar_event

Memory saves (user states a fact, no word "remember" required):
  "my wifi password is iloveindia"  → save_memory
  "my doctor is Dr. Sharma"         → save_memory
  "I work at Google"                → save_memory
  "passport expires june 2028"      → save_memory (+ optional set_reminder)

Contacts (name + phone number):
  "rohan's number is +919876543210" → save_contact
  "mom's mobile: +9199999"       → save_contact
  "emily — 9876543210"              → save_contact

Web search (current/live data, no word "search" required):
  "weather in mumbai"               → web_search
  "price of bitcoin today"          → web_search
  "latest iphone reviews"           → web_search
  "USD to INR rate"                 → web_search

Delegation (tell/ask/message someone):
  "ask emily to review the deck"    → delegate_message
  "tell rahul meeting moved to 3pm" → delegate_message
  "notify the team about delay"     → delegate_message

POSITIONAL / NUMERIC REFERENCES (resolve from conversation history):
When the user says "the first one", "#3", "second one", "last one", "all of them", or just a bare number,
LOOK AT recent_messages for the most recent NUMBERED LIST shown by Ari (visa opportunities,
calendar events, reminders, emails, search results, etc.) and route to the correct tool with the
positional index extracted into params.
  "apply to the first one"          → follow-up to whatever list was last shown
  "tell me more about story 2"      → news_deep_dive (story_index=2)
  "cancel #3"                       → cancel_reminder OR cancel_calendar_event (depends on context)
  "send all"                        → bulk_email or the tool that produced the last list (depends on context)
  "do the second one"               → context-dependent — find the most recent list in recent_messages
If recent_messages has NO numbered list and the user says a bare number/positional ref, ask for
clarification (return no tool call) rather than guessing.

HINGLISH ANAPHORA / FOLLOW-UPS (modify a previously-created item):
Hinglish often refers back to a prior item with "usme/uska/isko/wahi". Map them like this:
  "usme rahul ko bhi add karo"      → previous calendar event → update_calendar / reschedule_calendar_event with attendees
  "usme [person] ko hata do"        → remove attendee from previous event
  "uska time change kar do 5 baje"  → reschedule the previous event/reminder
  "isko cancel kar do"              → cancel the previous reminder/calendar/email
  "wahi reminder 5 baje pe set kar" → update_reminder
Look at recent_messages — what was the last thing Ari created? Modify THAT item.

EDIT-FLOW (user is iterating on a draft Ari just produced):
If recent_messages shows Ari just produced a draft (email, message, visa cover letter, etc.) and
the user says any of these → STAY in the same draft flow rather than returning null:
  "make it more formal" / "more casual" / "shorter" / "longer" / "punchier"
  "add a line about X" / "remove the part about Y" / "change tone to Z"
  "thoda formal kar do" / "isko short karo" (Hinglish equivalents)
Route to the SAME tool that produced the draft (e.g. send_email if it was an email, scheduled_message
if a message). The handler will detect "active draft + edit verb" and apply the edit.

BIAS RULES:
1. When [action verb] + [future time] is present, STRONGLY prefer set_reminder.
2. When [fact statement] is present ("my X is Y", "[person]'s X is Y"), STRONGLY prefer save_memory or save_contact.
3. When [current/live data question] is present, STRONGLY prefer web_search.
4. Only SKIP tool calls when the message is purely conversational — greetings, thanks, questions about yourself, casual chat with no actionable content.
5. If ambiguous between two tools, pick the one that matches more of the signal; it's OK to be slightly wrong — the handler can adapt.
6. HARD-FORCE delegate_message: any "tell/ask/notify/inform/message/update [person] to/about/that..." pattern → delegate_message. NEVER fall through to chat for these — the bot's anti-hallucination guard would refuse it. The handler will validate the contact and prompt for missing info if needed; that's the correct UX, NOT a chat reply.
7. LEAD-VERB ROUTING — ★ THE FIRST VERB IN THE MESSAGE DETERMINES THE TOOL. NEVER let body content override this. ★
   a. Lead verb is "schedule/book/set up/arrange/plan/fix/lagao" + meeting-noun (meeting/call/appointment/event/sync/standup/interview/lunch/dinner/catchup) → create_calendar_event. The presence of an email address is an ATTENDEE marker, NOT a send signal.
   b. Lead verb is "send/email/mail/write/draft/compose/reply/forward" + recipient → send_email (or schedule_email if the future time directly modifies the SEND verb itself like "send email at 9am tomorrow"). ANY meeting/schedule words that appear AFTER a comma, AFTER the recipient, or AFTER words like "to discuss/about/regarding/saying/that" are BODY CONTENT, not routing signal.
   c. If both verbs appear in the same lead clause (before any comma or "to discuss/about/regarding"), use the FIRST one.
   d. The LEAD CLAUSE is everything before the FIRST comma OR before words like "to discuss", "about", "regarding", "saying", "that the/I/we", "letting X know".
   Examples (memorize these patterns):
     • "schedule meeting tomorrow 3pm with john@x.com about Q3" → create_calendar_event (lead: schedule)
     • "book a call with priya@x.com Friday 5pm" → create_calendar_event (lead: book)
     • "set up sync with team@company.com tomorrow" → create_calendar_event (lead: set up)
     • "kal 11am pe rahul@x.com se meeting set karo" → create_calendar_event (lead: set/lagao)
     • "send a mail to john@x.com, let's schedule a meeting tomorrow" → send_email (lead: send mail; "schedule meeting" is body)
     • "email rahul about the friday deadline" → send_email (lead: email; "friday" is body content)
     • "draft an email about the kickoff meeting next week" → send_email (lead: draft email; "kickoff meeting" is body)
     • "mail priya saying the call is at 5pm" → send_email (lead: mail; "call at 5pm" is body)
     • "send email at 9am tomorrow to john@x.com" → schedule_email (time modifies SEND verb directly)

9. HARD-FORCE CONTEXT-RESOLUTION for single-word and positional replies:
   When user message is ≤3 words AND matches ["all", "first", "second", "last", a bare number like "1"/"2"/"3", "#N", "option N", "the X one"]:
   a. Look at the LAST 5 assistant messages in conversation history (recent_messages).
   b. Find the most recent NUMBERED LIST or option-presenting message Ari sent (e.g. "1. opportunity X / 2. opportunity Y", or "Reply: all / email 1, 3, 5 / apply to 1").
   c. Route to whatever tool produced that list, with the appropriate positional param. Examples:
     • Ari showed reminders → user says "first" → cancel_reminder / update_reminder with index=1
   d. If NO numbered list or option block visible in the last 5 turns, return NULL (do not call any tool — let chat clarify).
   ★ NEVER route bare "all" / "first" / "1" / "yes"-without-active-confirmation to view_dashboard, web_search, set_reminder, or any tool whose description merely happens to enum-match the word. The presence of a value in a tool's enum (like view_dashboard.section having "overview" or "all" aliases) does NOT make that tool the right choice for a context-dependent reply.

When calling a tool, always pass the user's full original message as "full_text" so the handler can parse details.

WORKFLOW CONTEXT (per-call dynamic — use this to route follow-up messages correctly):
${workflowHintsText}`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...contextMessages,
        { role: 'user', content: intentMessage }
      ];

      // SAFE MULTI-MODEL ROUTING (Bedrock migration, Phase 2):
      // If MODEL_INTENT_PRIMARY env var names a specific model (e.g. a Bedrock
      // alias like 'claude-haiku-4.5'), route through the unified chatCompletion
      // wrapper which dispatches to Bedrock or existing axios path automatically.
      // If the env var is unset, this resolves to `this.intentModel` (current
      // behavior) and the call path is unchanged.
      const llm = require('./llm-provider');
      const intentTaskModel = llm.modelFor('intent_primary');
      const useRouted = intentTaskModel && intentTaskModel !== this.intentModel;

      const toolChoice = explicitToolHint
        ? { type: 'function', function: { name: explicitToolHint } }
        : 'auto';

      const callIntentLLM = async (toolList) => {
        if (useRouted) {
          // Route via unified chatCompletion (Bedrock-aware + OpenAI-shape response)
          const resp = await llm.chatCompletion({
            model: intentTaskModel,
            messages,
            tools: toolList,
            tool_choice: toolChoice,
            temperature: 0,
            max_tokens: 300
          }, {
            task: 'intent_primary',
            timeout: 8000,
            enablePromptCache: true,  // 90% off on Bedrock Claude
          });
          // Track usage (cost monitoring, no-leakage audit)
          try {
            const tracker = require('./model-usage-tracker.service');
            tracker.log({ task: 'intent_primary', model: intentTaskModel, usage: resp?.data?.usage, userPhone: options.userPhone });
          } catch (_) { /* tracker optional */ }
          return resp;
        }
        return this._callOpenAI({
          model: this.intentModel,
          messages,
          tools: toolList,
          tool_choice: toolChoice,
          temperature: 0,
          max_tokens: 300
        }, {
          timeout: 8000,
          traceName: 'intent-detection',
          userId: options.userPhone
        });
      };

      let response = await callIntentLLM(tools);

      // FULL-SET RETRY: when the LLM saw only a keyword/embedding-picked tool
      // subset and refused to call ANY of them, the most common cause (per the
      // live eval GAP-REPORT) is that the subset was wrong and the correct
      // tool wasn't on the menu at all. One retry with the complete tool set
      // costs a second intent call but only fires on exactly the failure case.
      // Kill switch: INTENT_FULLSET_RETRY=false.
      const firstChoiceHadTool = !!(response?.data?.choices?.[0]?.message?.tool_calls?.length);
      if (!firstChoiceHadTool && usedToolSubset && process.env.INTENT_FULLSET_RETRY !== 'false') {
        const fullTools = getToolDefinitions();
        if (fullTools.length > tools.length) {
          logger.info(`[Intent] Subset (${tools.length} tools) produced no tool call — retrying with full set (${fullTools.length})`);
          try {
            response = await callIntentLLM(fullTools);
          } catch (retryErr) {
            // Keep the original (no-tool) response — degrading to chat is
            // better than failing the whole message on a retry error.
            logger.warn(`[Intent] Full-set retry failed, keeping first result: ${retryErr.message}`);
          }
        }
      }

      // Validate tool-call params against Zod schemas (if registered).
      // This catches LLM hallucinations where the argument shape is wrong.
      let validated;
      try {
        const { validateToolCall } = require('./tool-schemas');
        validated = validateToolCall(response);
      } catch (e) {
        validated = null; // Zod validation not available — fall through
      }

      const choice = response.data.choices[0];

      // If LLM called a tool -> extract intent + params
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        const toolCall = choice.message.tool_calls[0];
        let toolName = toolCall.function.name;
        let params = {};

        try {
          params = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          params = { full_text: message };
        }

        // Ensure full_text is always populated
        if (!params.full_text) {
          params.full_text = message;
        }

        const routed = enforceExplicitReminderIntent(message, toolName, params);
        if (routed.toolName !== toolName) {
          logger.warn('Corrected explicit reminder intent selected as another tool', {
            selectedTool: toolName
          });
        }
        toolName = routed.toolName;
        params = routed.params;

        // Explicit parser matches are deterministic user commands. Some
        // OpenAI-compatible providers occasionally ignore a named tool_choice
        // and return another tool. Do not let that become an unrelated action.
        if (explicitMessageToolHint && toolName !== explicitMessageToolHint) {
          logger.warn('[Intent] Corrected provider tool that conflicted with explicit command', {
            selectedTool: toolName,
            explicitTool: explicitMessageToolHint,
          });
          toolName = explicitMessageToolHint;
          params = { full_text: message };
        }

        // If Zod validation is available and the params are invalid, log a warning
        // but proceed — handlers have their own defensive parsing. This lets us
        // collect data on LLM hallucinations without breaking flows immediately.
        if (validated && !validated.ok) {
          logger.warn(`Tool params failed schema validation: ${toolName}`, {
            issues: validated.issues,
            params
          });
        }

        const intentType = getIntentForTool(toolName);
        logger.info(`Tool calling intent: ${toolName} -> ${intentType}`, { params });
        return { type: intentType, params, toolName };
      }

      // A named tool choice should always produce a call. If a provider drops
      // it anyway, execute the explicit tool with the original text so clear
      // commands never degrade into a generic chat answer.
      if (explicitToolHint) {
        logger.warn(`[Intent] Provider returned no tool for explicit hint ${explicitToolHint}; using parser fallback`);
        return {
          type: getIntentForTool(explicitToolHint),
          params: { full_text: message },
          toolName: explicitToolHint,
          _explicitFallback: true,
        };
      }

      // No tool called -> general chat
      return null;
    } catch (error) {
      let explicitFallback = null;
      try {
        const { getExplicitToolHint, getIntentForTool } = require('./tool-definitions');
        const hint = getExplicitToolHint(message, options.contextHints || {});
        if (hint) {
          explicitFallback = {
            type: getIntentForTool(hint),
            params: { full_text: message },
            toolName: hint,
            _explicitFallback: true,
          };
        }
      } catch (_) { /* keep normal degraded handling */ }

      // Circuit breaker open — fall through to chat so the user gets the
      // graceful-degradation message instead of a hard error.
      if (error.degraded) {
        if (explicitFallback) return explicitFallback;
        logger.warn(`Intent detection: OpenAI circuit open, falling back to chat`);
        return null;
      }

      // FIX: previously THREW on 429/503 which surfaced "AI unavailable" to
      // users. Multi-provider routing can hit provider-level rate limits more
      // frequently, so we degrade gracefully to general chat instead.
      // The bot still responds; it just uses the LLM's general-chat path
      // rather than tool-routing for this one message.
      const status = error.response?.status;
      if (status === 429 || status === 503) {
        if (explicitFallback) return explicitFallback;
        logger.warn(`Intent detection rate-limited/unavailable (${status}), falling back to general chat gracefully`);
        return null;
      }
      if (explicitFallback) {
        logger.warn(`[Intent] Detection failed for explicit tool ${explicitFallback.toolName}; using parser fallback: ${error.message}`);
        return explicitFallback;
      }
      logger.warn('Intent detection error, falling back to chat:', error.message, error.stack);
      return null;
    }
  }

  // Keep backward compatibility -- old callers use detectSpecialCommand
  async detectSpecialCommand(message, options = {}) {
    return this.detectIntent(message, options);
  }

  /**
   * Compact v2 intent system prompt — ~52% smaller than v1, same accuracy
   * (validated 2026-04-25 against the 102-case feature suite).
   *
   * Trimming strategy:
   *   - Combined redundant rules from RULES + IMPLICIT INTENT EXAMPLES
   *   - Cut examples per category from 4-8 down to 2 (Claude generalizes well)
   *   - Compressed POSITIONAL / HINGLISH-ANAPHORA / EDIT-FLOW from prose to
   *     terse rule lines
   *   - Removed restating WhatsApp abbreviations / typos (Claude handles them)
   *
   * Activate via INTENT_PROMPT_VERSION=v2 env var. Default is v1 for safety.
   * Saves ~$2-3/mo per 1K user messages on Anthropic prompt-cache writes.
   */
  _buildIntentSystemPromptV2(workflowHintsText) {
    return `You are Ari's intent detection system for a WhatsApp AI assistant. Decide if the user's message needs a tool call or is casual chat (no tool).

RULES:
- Understand any language (English, Hindi, Hinglish, French, Spanish, German, Arabic, etc.). Slang/abbreviations/typos OK; ignore filler ("bro", "yaar", "lol").
- Current message takes priority over history. Use history only to resolve "yes" / "do it" / "the first one" / "cancel that".
- Real-time data questions (weather, prices, exchange rates, news, "current X") → web_search. Don't answer from memory.
- "search the web" / "google it" / "look up" / "find out" → web_search.

ROUTING SHORTCUTS:
- "tell/message/notify [person|team]" + content → delegate_message
- "remind [person]" → set_reminder (with target_name)
- "done [habit]" / "completed [habit]" → manage_habits
- "what's on my plate" / "today's schedule" / "brief me" → daily_briefing
- "dashboard" / "my stats" → view_dashboard
- "tasks assigned to me" → manage_tasks list_assigned_to_me
- "tasks I gave/delegated" → manage_tasks list_assigned_by_me

IMPLICIT INTENTS (no keyword needed):
- Reminder = action + future time: "call X at 5", "gym tomorrow 6am", "pay bill by friday", "meds rozana 9pm"
- Calendar event = named event + time: "dentist 3pm thursday", "meet john 2pm tuesday"
- Memory save = factual statement: "my wifi password is X", "passport expires june 2028"
- Contact save = name + phone: "rohan's number is +91...", "mom: 9876543210"
- Web search = live data Q: "weather in mumbai", "price of bitcoin"

POSITIONAL/NUMERIC REFS:
"first one" / "#3" / "send all" / bare numbers → look at recent_messages for the most recent NUMBERED LIST (visa opps, calendar events, etc.) and route to that tool with the index. If no list visible, return null (ask for clarification).

HINGLISH ANAPHORA (modify previous item):
"usme X add karo" / "uska time change" / "isko cancel" / "wahi reminder X baje" → modify the LAST item Ari created (visible in recent_messages) — pick update_reminder / reschedule_calendar_event / cancel_* accordingly.

DRAFT EDIT FLOW:
If recent_messages shows Ari just produced a draft (email/visa/message) and user says "make it more formal" / "shorter" / "add line about X" / "isko short karo" / "thoda formal kar do" → STAY in same draft tool (handler applies the edit), don't return null.

BIAS:
- action+future_time → set_reminder | fact statement → save_memory or save_contact | live data Q → web_search
- Skip tools only for purely conversational messages (greetings, thanks, casual chat)
- Ambiguous between two tools → pick the closest signal match; handler can adapt

Always pass the user's full original message as "full_text" so handlers can re-parse details.

WORKFLOW CONTEXT (per-call dynamic — use to route follow-ups):
${workflowHintsText}`;
  }

  /**
   * v3 intent system prompt (default since Jul 2026) — intent-first reading of
   * casual WhatsApp text plus an explicit clarification policy.
   *
   * What changed vs v1/v2 and why:
   *   - Removed "LEAD-VERB ROUTING / first verb determines the tool" — Hinglish
   *     is verb-final and casual messages are often verbless fragments, so the
   *     rule degraded to noun-keyword matching. Replaced with "primary action
   *     vs body content" guidance that preserves the send-email-vs-book-meeting
   *     fix the lead-verb rule was created for.
   *   - Removed "it's OK to be slightly wrong — pick one" (bias rule 5). The
   *     model now has a request_clarification tool: for side-effectful actions
   *     it should ask ONE short question instead of guessing.
   *   - Removed single-word ALWAYS mappings ("dashboard" = view_dashboard etc.)
   *     that overrode conversation context.
   *   - Kept (they encode real regressions): real-time-data → web_search,
   *     anaphora resolution priorities + hard vetoes, positional-reference
   *     resolution, Hinglish anaphora, draft edit flow, full_text passthrough.
   *
   * Roll back with INTENT_PROMPT_VERSION=v1 or v2.
   */
  _buildIntentSystemPromptV3(workflowHintsText) {
    return `You are the intent-detection layer for Ari, a WhatsApp AI assistant. Decide which tool (if any) handles the user's message and extract its parameters. You are reading REAL WhatsApp chat: typos, slang, abbreviations, Hinglish or any other language, missing words, voice-transcription errors, and one-word replies are all NORMAL. Read for MEANING — never require exact keywords, never punish spelling.

HOW TO DECIDE (in order):
1. Read the current message TOGETHER WITH the conversation history and the workflow context at the bottom. Short replies ("yes", "2", "ok do it", "usko cancel karo") almost always continue the previous exchange — resolve them against it. The current message states the goal; history supplies the referents.
2. Identify what the user WANTS DONE, not which words they used. "gym tomorrow 6am" wants a reminder though "remind" never appears; "shoot raj a mail abt the delay" wants send_email despite the slang; "remnd me abt d visa docs kal" is a reminder despite four typos.
3. If exactly one tool fits → call it with carefully extracted parameters.
4. If the message is purely conversational (greeting, thanks, opinion, chit-chat with nothing actionable) → call NO tool.
5. If it is clearly a request for action but you cannot tell WHICH action or WHO/WHAT the target is — and a wrong pick would send, delete, book, assign, or notify someone — call request_clarification with ONE short question (add 2-3 options when useful). A quick question beats a wrong action. For read-only requests (show/list/view) never ask — pick the closest tool.
6. NEVER invent parameters. If an email address, phone number, time, or name was not given by the user or the conversation, leave it empty or ask via request_clarification. No fabricated recipients, no guessed times.

REAL-TIME DATA: questions about weather, news, prices, exchange rates, crypto/stock prices, sports scores, "what is X today", "current/latest X" → web_search. Never answer these from training knowledge. Explicit "search / google it / look up" → web_search regardless of topic.

DISAMBIGUATION GUIDES (judge the whole message — these are patterns, not string rules):
- Passing words to a person NOW ("tell/ask/notify/message X that ...", "X ko bol dena ...") → delegate_message. Scheduling a future nudge for someone ("remind X to ...") → set_reminder with target. Never answer these conversationally — a real send/reminder tool must handle them.
- Action + future time, no attendees → set_reminder. Named appointment/meeting/call with a time, especially with people or emails attached → create_calendar_event (an email address in a scheduling request is an ATTENDEE, not a reason to send email).
- One message often contains an action PLUS message-body content: text after "about / regarding / saying / that / ke baare mein / bolke" usually DESCRIBES content, it does not request a second action. "send a mail to john, let's schedule a meeting tomorrow" → send_email (the meeting phrase is the email's content). "schedule meeting tomorrow 3pm with john@x.com about Q3" → create_calendar_event.
- Hindi/Hinglish puts the verb LAST ("rahul ko kal ka agenda mail kar dena" → send_email). Judge from the whole sentence, never just the first word.
- Statement of personal fact ("my wifi password is X", "passport expires june 2028", "I work at Google") → save_memory. Name + phone number → save_contact.
- "done <habit>" / "completed <habit>" where history shows habit tracking → manage_habits. A bare "done" replying to a task/briefing prompt is not a habit — leave it to conversation handling (no tool) unless history says otherwise.
- Searching the user's OWN saved data (notes, tasks, reminders, contacts, memories — in any language: "docker wala note dhundo", "find that thing i saved") → the matching personal-data tool, NEVER web_search.
- Questions about the user's OWN orders, deliveries, refunds, bookings, or tickets ("what's my order status", "where's my refund") are NOT web searches — ask which order via request_clarification.

ANAPHORA — "that / it / usko / uska / wahi / isko" (resolve in this order, stop at first match):
1. Last tool-created entity of the SAME CLASS as the anaphor (note→note, task→task, meeting→meeting, reminder→reminder) within the last 6 turns.
2. Last open confirmation flow (see WORKFLOW CONTEXT) if step 1 found nothing.
3. Last tool-created entity of ANY class within the last 3 turns.
4. Otherwise call request_clarification ("Which one — ...?"). Do not guess.
HARD VETOES (never violate): anaphora NEVER resolve to web-search results, news articles, or product specs, and NEVER to entities that only appeared inside the assistant's own examples or clarifying questions. "change the time to 5pm" right after a booking/reminder → update THAT entity, keeping its date unless changed. "actually assign that to <email>" right after creating a task → manage_tasks assign (the email is the ASSIGNEE — never send_email). "delete/cancel that" → same-class entity only.

POSITIONAL / NUMBER REPLIES ("1", "#3", "the first one", "2nd wala", "last one", "all", "send all"):
Find the most recent NUMBERED LIST or option menu the assistant showed in the history and route to the tool that produced THAT list, passing the index. Reminder list → cancel_reminder/update_reminder; news briefing → news_deep_dive; image list → manage_images select_number; clarification options → the tool the question was about. If NO list or option question is visible in history, do NOT guess a tool from the number — return no tool call, or request_clarification if the user clearly expects an action.
HARD VETO: a bare "all" / "first" / "1" / "yes" with NO visible context must NEVER route to view_dashboard, web_search, set_reminder, or any tool merely because that word appears in the tool's enum values or description. No anchor in history → no tool call.

HINGLISH FOLLOW-UPS (modify a previous item): "usme rahul ko add karo" → add attendee to the last event; "uska time change kar do 5 baje" → reschedule that event/reminder; "isko cancel kar do" → cancel that same item; "wahi reminder 5 baje pe set kar" → update_reminder. Look at what the assistant last created and modify THAT.

DRAFT EDIT FLOW: if the assistant just produced a draft (email, message, document) and the user says "make it more formal", "shorter", "add a line about X", "thoda short karo" → route to the SAME tool that produced the draft; the handler applies the edit. Do not return null and do not start a new draft.

Always include the user's complete original message as "full_text" in the tool parameters so handlers can re-parse details.

WORKFLOW CONTEXT (live state — outranks older history when routing follow-ups):
${workflowHintsText}`;
  }

  formatIntentContextHints(contextHints = {}) {
    const hints = [];

    if (contextHints.pendingIntentClarification) {
      const c = contextHints.pendingIntentClarification;
      const opts = Array.isArray(c.options) && c.options.length
        ? ` Options offered: ${c.options.map((o, i) => `${i + 1}) ${o}`).join(' ')}.`
        : '';
      hints.push(
        `IMPORTANT: The bot just asked the user a clarifying question: "${c.question}".${opts} ` +
        `The user's ORIGINAL request was: "${String(c.originalText || '').slice(0, 200)}". ` +
        `The current message is almost certainly the ANSWER to that question — resolve it against the options ` +
        `(a bare number picks that option) and route to the tool for the chosen action, reusing details from the original request. ` +
        `Only treat it as a new request if it clearly changes topic.`
      );
    }
    if (contextHints.hasDocumentAttachment) hints.push('The user recently attached a document or file.');
    if (contextHints.activeBulkEmail) hints.push(`There is an active bulk email draft with ${contextHints.bulkEmailRecipientCount || 0} recipient(s)${contextHints.bulkEmailScheduled ? ', and it is scheduled' : ''}.`);
    if (contextHints.activeScheduledEmail) hints.push('There is an active single scheduled email confirmation.');
    if (contextHints.activeEmailDraftConfirmation) hints.push('There is an active single email draft confirmation.');
    if (contextHints.activeCalendarConfirmation) hints.push(`There is an active calendar confirmation flow${contextHints.calendarConfirmationType ? ` (${contextHints.calendarConfirmationType})` : ''}.`);
    if (contextHints.activeLeaveApproval) hints.push('The user is in the middle of approving or rejecting a leave request.');
    if (contextHints.activeStandupSetup) hints.push(`The user is setting up a standup${contextHints.standupSetupStep ? ` and is currently on the ${contextHints.standupSetupStep} step` : ''}.`);
    if (contextHints.activeStandupResponse) hints.push(`The user is answering standup questions${contextHints.standupQuestionIndex ? ` and is currently on question ${contextHints.standupQuestionIndex}` : ''}.`);
    if (contextHints.activePollVote) hints.push('The user has an active poll voting prompt.');
    if (contextHints.hasRecentEmailContext) hints.push(`There is recent email context${contextHints.recentEmailType ? ` (${contextHints.recentEmailType})` : ''}.`);
    if (contextHints.lastBotAction?.action) hints.push(`The bot's last action was: "${contextHints.lastBotAction.action}". Use this to resolve ambiguous follow-ups like "cancel this", "delete it", "show more", "do it" - they likely refer to this action's domain.`);
    if (contextHints.imageWaitingForSaveConfirm) hints.push('An image was recently generated/shared and is waiting for the user to confirm saving it.');
    if (contextHints.dashboardImageListActive) hints.push('The user was just shown a numbered list of images. A number reply selects an image.');

    return hints.length > 0 ? hints.join('\n') : 'No special active workflow state.';
  }

  // ========== UNIFIED CONFIRMATION CLASSIFIER ==========

  /**
   * Classify a user's response in an active workflow context.
   * Replaces 50+ duplicated yes/no regex patterns across 14 workflow states.
   *
   * @param {string} text - User's message
   * @param {string} workflowType - e.g. 'calendar_event', 'email_draft', 'contact_save', 'csv_import', 'meeting_join', 'leave_approval', 'sales_email', 'poll_vote'
   * @param {string} contextSummary - 1-line summary of what's being confirmed (e.g. "Meeting with Rahul tomorrow at 3pm")
   * @returns {{ decision: string, option_number?: number, edit_instruction?: string }}
   *   decision: 'confirm' | 'cancel' | 'edit' | 'select_option' | 'new_request'
   */
  async classifyConfirmation(text, workflowType, contextSummary = '') {
    // Short-circuit for very obvious single-word responses (fast path, no LLM needed)
    const lower = text.toLowerCase().trim();
    const quickConfirm = /^(yes+|y|ya+|yeah|yep|yup|yess+|sure|ok+|okay|okie|send|confirm|go|done|haan+|han|hanji|ha|ji|ji\s*haan|bilkul|zaroor|bhej|bhejo|hnji|approve|go\s*ahead|do\s*it|theek\s*hai|thik\s*hai|haan\s*bhej(\s*do)?|bhej\s*do|bhej\s*de|kar\s*do|kar\s*de|karo|krdo|send\s*it|looks?\s*good|perfect|great|chalega)$/i;
    const quickCancel = /^(no+|n|nope|nah|na|cancel|stop|nahi+|nhi|mat|nai|nahin|rehne\s*do|rehne\s*de|chodo|chhodo|chod\s*do|skip|don'?t|never\s*mind|nvm|ruk|ruko|band\s*kar|mat\s*bhej|mat\s*bhejo|leave\s*it|forget\s*it)$/i;

    if (quickConfirm.test(lower)) {
      return { decision: 'confirm' };
    }
    if (quickCancel.test(lower)) {
      return { decision: 'cancel' };
    }

    // For numeric responses (option selection)
    const numMatch = lower.match(/^(\d+)$/);
    if (numMatch) {
      return { decision: 'select_option', option_number: parseInt(numMatch[1], 10) };
    }

    // For anything ambiguous, use lightweight LLM call (Bedrock-aware)
    try {
      const response = await llm.chatCompletion({
        model: this.fastModel,
        messages: [
          {
            role: 'system',
            content: `You classify user responses in a WhatsApp assistant workflow. The user was asked to confirm an action.

Workflow: ${workflowType}
Pending action: ${contextSummary}

Classify the user's response as exactly ONE of:
- "confirm" — they agree, approve, want to proceed (yes, sounds good, go ahead, that works, haan bhej do, theek hai, perfect, looks good)
- "cancel" — they refuse, decline, want to stop (no, nah, cancel it, don't, never mind, rehne do)
- "edit" — they want to modify something (change the time, make it shorter, add more people, use a different subject)
- "select_option" — they're picking an option by number or description (option 2, the first one, the morning slot)
- "new_request" — this is a completely different request unrelated to the pending action

Reply with ONLY a JSON object: {"decision":"confirm|cancel|edit|select_option|new_request","option_number":N,"edit_instruction":"..."}`
          },
          { role: 'user', content: text }
        ],
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        ...llm.defaultBodyExtras()
      }, { timeout: 3000 });

      const result = JSON.parse(response.data.choices[0].message.content);
      // Validate the decision against the allowed set. A missing/garbled
      // decision must NOT default to 'confirm' — that silently fires the
      // pending action (send/delete/book) on a reply the user never meant
      // as approval. 'new_request' is the safe default: nothing executes,
      // the message falls through to normal routing.
      const ALLOWED_DECISIONS = ['confirm', 'cancel', 'edit', 'select_option', 'new_request'];
      const decision = ALLOWED_DECISIONS.includes(result.decision) ? result.decision : 'new_request';
      return {
        decision,
        option_number: result.option_number,
        edit_instruction: result.edit_instruction
      };
    } catch (error) {
      logger.warn('Confirmation classifier fallback:', error.message);
      // Fallback: treat as new_request (safest — won't accidentally confirm/cancel)
      return { decision: 'new_request' };
    }
  }

  // ========== THREAD SUMMARY ==========

  async summarizeRecentMessages(userPhone, count = 20, focus = '') {
    try {
      const session = currentChatSession();
      const result = session?.sessionId
        ? await query(
          `SELECT role, content, created_at FROM conversation_history
           WHERE user_phone = $1 AND session_id = $2::uuid
           ORDER BY created_at DESC
           LIMIT $3`,
          [userPhone, session.sessionId, count]
        )
        : await query(
          `SELECT role, content, created_at FROM conversation_history
           WHERE user_phone = $1 AND session_id IS NULL
           ORDER BY created_at DESC
           LIMIT $2`,
          [userPhone, count]
        );

      if (result.rows.length === 0) return 'No messages to summarize.';

      const messages = result.rows.reverse();
      const text = messages.map(m =>
        `[${new Date(m.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}] ${m.role}: ${m.content}`
      ).join('\n');

      // Bedrock-aware
      const safeFocus = String(focus || '').trim().slice(0, 500);
      const response = await llm.chatCompletion({
        model: this.fastModel,
        messages: [
          { role: 'system', content: 'Summarize this conversation concisely. Highlight key topics, decisions, action items, and important information. Keep it brief and organized.' },
          { role: 'user', content: `Summarize these ${messages.length} messages${safeFocus ? ` with special focus on: ${safeFocus}` : ''}:\n\n${text.slice(0, 4000)}` }
        ],
        temperature: 0.3,
        max_tokens: 500,
        ...llm.defaultBodyExtras()
      }, { timeout: 15000 });

      return `*Summary of last ${messages.length} messages:*\n\n${response.data.choices[0].message.content}`;
    } catch (error) {
      logger.error('Thread summary error:', error.message);
      return 'Could not generate summary. Try again?';
    }
  }

  async summarizeByTimeframe(userPhone, timeframe) {
    try {
      let interval;
      switch (timeframe.toLowerCase()) {
        case 'today': interval = '24 hours'; break;
        case 'yesterday': interval = '48 hours'; break;
        case 'this week': interval = '7 days'; break;
        default: interval = '24 hours';
      }

      const session = currentChatSession();
      const result = session?.sessionId
        ? await query(
          `SELECT role, content, created_at FROM conversation_history
           WHERE user_phone = $1 AND session_id = $2::uuid
             AND created_at > NOW() - INTERVAL '${interval}'
           ORDER BY created_at ASC
           LIMIT 100`,
          [userPhone, session.sessionId]
        )
        : await query(
          `SELECT role, content, created_at FROM conversation_history
           WHERE user_phone = $1 AND session_id IS NULL
             AND created_at > NOW() - INTERVAL '${interval}'
           ORDER BY created_at ASC
           LIMIT 100`,
          [userPhone]
        );

      if (result.rows.length === 0) return `No messages found for ${timeframe}.`;

      const text = result.rows.map(m =>
        `[${new Date(m.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}] ${m.role}: ${m.content}`
      ).join('\n');

      // Bedrock-aware
      const response = await llm.chatCompletion({
        model: this.fastModel,
        messages: [
          { role: 'system', content: 'Summarize this conversation. Highlight key topics, decisions, action items. Be concise.' },
          { role: 'user', content: `Summarize ${timeframe}'s conversation (${result.rows.length} messages):\n\n${text.slice(0, 4000)}` }
        ],
        temperature: 0.3,
        max_tokens: 500,
        ...llm.defaultBodyExtras()
      }, { timeout: 15000 });

      return `*Summary (${timeframe}):*\n\n${response.data.choices[0].message.content}`;
    } catch (error) {
      logger.error('Timeframe summary error:', error.message);
      return 'Could not generate summary. Try again?';
    }
  }

  // ========== HISTORY STATS ==========

  async quickAI(prompt, options = {}) {
    // Route via the task-aware provider wrapper. If MODEL_QUICK_AI is set
    // (e.g. "nova-lite"), this goes to Bedrock — which has ~100× the RPM
    // of Gemini free-tier and bypasses the 429 cascade that trips the
    // openai circuit breaker on cron-burst workloads (auto-label,
    // translation, email categorization). If unset, behavior is unchanged
    // (falls back to llm.defaultModel() / fastModel()).
    try {
      const body = {
        model: options.model, // may be undefined; chatCompletion resolves via task
        messages: [
          { role: 'system', content: options.systemPrompt || 'You are a helpful assistant. Be concise.' },
          { role: 'user', content: prompt }
        ],
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens || 500,
        ...llm.defaultBodyExtras('fast')
      };

      const response = await llm.chatCompletion(body, {
        task: 'quick_ai',
        timeout: options.timeout || 10000
      });
      return response.data.choices[0].message.content;
    } catch (error) {
      logger.error('quickAI error:', error.message);
      throw error;
    }
  }

  async getHistoryStats(userPhone) {
    try {
      const result = await query(
        `SELECT
           COUNT(*) as total_messages,
           MIN(created_at) as first_message,
           MAX(created_at) as last_message
         FROM conversation_history
         WHERE user_phone = $1`,
        [userPhone]
      );

      return result.rows[0];
    } catch (error) {
      return { total_messages: 0 };
    }
  }

  // ========== STANDUP ALIGNMENT ==========

  async analyzeStandupAlignment(morningPlan, eveningActual) {
    try {
      const result = await generateObject({
        model: llm.sdkModel('fast'),
        schema: StandupAlignmentSchema,
        system: `You compare a team member's morning plan with their evening update.

Rules:
- "completed": items from the morning plan that appear done in the evening update (use the morning wording)
- "missed": items from the morning plan NOT mentioned in the evening update
- "unplanned": items in the evening update that were NOT in the morning plan
- "alignment_score": (completed count / total planned count) * 100, rounded to integer. If no morning plan, use 100.
- "summary": one concise sentence explaining the day (mention key deviations)`,
        prompt: `MORNING PLAN:\n${morningPlan || '(no plan submitted)'}\n\nEVENING UPDATE:\n${eveningActual || '(no update submitted)'}`,
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(15000)
      });
      return result.object;
    } catch (error) {
      logger.error('analyzeStandupAlignment error:', error.message);
      return {
        completed: [], missed: [], unplanned: [],
        alignment_score: 0,
        summary: 'Analysis unavailable — AI service error.'
      };
    }
  }

  // ========== RESUME-UPLOAD INTENT CLASSIFIER ==========
  /**
   * Classify what the user wants Ari to do when they send a resume PDF.
   *
   * Two semantic buckets (no keyword lists — the LLM must understand meaning):
   *   - "visa":  user wants Ari to use this resume for their visa profile —
   *              analyze it, find opportunities, apply to things, build
   *              EB-1A / O-1A / extraordinary-ability evidence, etc.
   *   - "save":  user just wants to store/forward/reference the file — for
   *              later, to share with someone, to attach to another task,
   *              or for a completely unrelated conversation.
   *
   * When in doubt (empty caption, ambiguous text, LLM unavailable) → "save".
   * This is the safer default: it never fires the heavy visa pipeline on a
   * file the user didn't explicitly hand over for visa work.
   *
   * @param {string|null|undefined} caption - whatever the user wrote with the PDF
   * @returns {Promise<'visa'|'save'>}
   */
  async classifyResumeIntent(caption) {
    const text = String(caption || '').trim();
    if (!text) return 'save';  // bare PDF = save, never trigger visa pipeline

    // Short ambiguous captions like "ok" / "here" / "👍" — also default to save.
    if (text.length < 3) return 'save';

    if (!this.apiKey) return 'save';

    try {
      const result = await generateObject({
        model: llm.sdkModel('fast'),
        schema: ResumeIntentSchema,
        system: `You classify what a user wants when they send a resume/CV with a message.

Output exactly one of two labels:
- "visa" — user wants Ari to process this resume for their US visa journey: analyze their profile, find opportunities (judging, speaking, awards, memberships, media, publications), apply to things on their behalf, build EB-1A / O-1A / extraordinary-ability evidence, get a match against USCIS criteria, or any other visa-profile-building action.
- "save" — user just wants Ari to store this file, forward it somewhere, share it with a contact, attach it to another task, reference it later, or any non-visa purpose.

Judge by MEANING, not by presence of keywords. A caption like "help me with this" paired with a resume from an already-enrolled visa user leans "visa". A caption like "here's my resume for the job I was telling you about" leans "save" (not visa). A caption like "find me opportunities" clearly means "visa". If you cannot confidently tell — output "save".`,
        prompt: `Caption the user sent with the resume: "${text.slice(0, 500)}"`,
        temperature: 0,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(8000)
      });
      return result.object.intent === 'visa' ? 'visa' : 'save';
    } catch (error) {
      logger.warn(`classifyResumeIntent failed, defaulting to "save": ${error.message}`);
      return 'save';
    }
  }

  // ========== VISA-CRITERIA PICKER REPLY PARSER ==========
  /**
   * Parse the user's reply to the criteria picker prompt into a structured
   * decision: which categories they want, and what location filter to apply.
   *
   * The LLM understands natural phrasings — "all in India", "1, 3 remote",
   * "just speaking online", "judging + authorship anywhere", etc.
   *
   * @param {string} text - user's reply to the picker
   * @returns {Promise<{
   *   categories: Array<'judging'|'peer_review'|'speaking'|'authorship'|'membership'|'award'|'media'>,
   *   location: { mode: 'anywhere'|'online'|'specific', value: string|null }
   * } | null>}
   *   Returns null if the reply doesn't look like a picker response at all
   *   (so the caller can fall through to generic chat handling).
   */
  async parseCriteriaPickerReply(text) {
    const clean = String(text || '').trim();
    if (!clean || !this.apiKey) return null;

    const system = `You parse a user's reply to Ari's USCIS criteria picker. They were asked which visa-evidence categories to pursue and optionally where.

CATEGORIES (canonical names):
1 = judging           (demos, competitions, peer review panels)
2 = peer_review       (academic journal / conference reviewers)
3 = speaking          (conference CFPs, meetups, keynotes)
4 = authorship        (journal + guest-column opportunities)
5 = membership        (IEEE Senior, ACM Fellow, selective societies)
6 = award             (award programs accepting nominations)
7 = media             (podcast guest, HARO expert source)

LOCATION MODES:
- "online"   — user explicitly wants remote/virtual/online-only opportunities
- "specific" — user named a particular city, country, state, or region to target
- "anywhere" — user said anywhere/any/global OR did not mention location at all

NON-PICKER REPLIES:
If the user's text is clearly unrelated (e.g. a fresh request, a question, small talk, a greeting, forgot-about-the-picker) return {"is_picker_reply": false} and nothing else.

Otherwise return:
{
  "is_picker_reply": true,
  "categories": ["<canonical name>", ...] | "all",
  "location": {
    "mode": "anywhere" | "online" | "specific",
    "value": "<place name>" | null
  }
}

Rules:
- If the user said "all" / "every" / "everything" → categories = "all".
- If specific numbers OR category keywords → list only those canonical names.
- If BOTH a specific place AND "remote/online" appear (e.g. "Bangalore but remote OK"), prefer mode="specific" with that place.
- "value" is a proper-cased place name (e.g. "India", "Berlin", "Bay Area"). Null when mode != "specific".
- Do not invent categories or locations not present in the user's text.`;

    try {
      const result = await generateObject({
        model: llm.sdkModel('fast'),
        schema: CriteriaPickerSchema,
        system,
        prompt: clean.slice(0, 500),
        temperature: 0,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(8000)
      });
      const parsed = result.object;
      if (!parsed.is_picker_reply) return null;

      const ALL_CATS = ['judging', 'peer_review', 'speaking', 'authorship', 'membership', 'award', 'media'];
      let categories;
      if (parsed.categories === 'all') {
        categories = [...ALL_CATS];
      } else if (Array.isArray(parsed.categories)) {
        categories = parsed.categories
          .map(c => String(c).toLowerCase().trim())
          .filter(c => ALL_CATS.includes(c));
      } else {
        categories = [];
      }

      const locMode = parsed.location?.mode;
      const location = {
        mode: ['online', 'specific', 'anywhere'].includes(locMode) ? locMode : 'anywhere',
        value: locMode === 'specific' ? String(parsed.location?.value || '').trim() || null : null
      };
      // If mode is "specific" but no value came back, downgrade to "anywhere"
      if (location.mode === 'specific' && !location.value) location.mode = 'anywhere';

      if (categories.length === 0) return null;  // not a real picker reply after all
      return { categories, location };
    } catch (error) {
      logger.warn(`parseCriteriaPickerReply failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = new AIService();
