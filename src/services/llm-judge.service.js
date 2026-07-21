/**
 * LLM-as-a-Judge — uses the active LLM provider to auto-score Ari's responses.
 *
 * Routed through `llm-provider.js`, so it follows the same provider as the rest
 * of Ari (Gemini by default, OpenAI/Groq via rollback). Set LLM_JUDGE_MODEL
 * to override the model used for scoring (default: the active provider's fast
 * model, e.g. gemini-3-flash-preview).
 *
 * How it works:
 *   1. After Ari answers a user, we fire-and-forget a judge call
 *   2. Judge asks: "Did the assistant correctly address what the user wanted?"
 *   3. Returns 1-5 score + reasoning
 *   4. Score posted back to Langfuse as a `user-quality` score
 *   5. Very low scores (≤2) auto-reported to Sentry for alerting
 *
 * Tunable via env:
 *   LLM_JUDGE_ENABLED=true       - master switch (default: off)
 *   LLM_JUDGE_SAMPLE_RATE=0.1    - 10% sampling (default)
 *   LLM_JUDGE_MODEL=<model>      - override model (default: llm.fastModel())
 */

const axios = require('axios');
const logger = require('../utils/logger');
const llm = require('./llm-provider');

// Config from env
const ENABLED = process.env.LLM_JUDGE_ENABLED === 'true';
const SAMPLE_RATE = parseFloat(process.env.LLM_JUDGE_SAMPLE_RATE || '0.1');
const MODEL = process.env.LLM_JUDGE_MODEL || llm.fastModel();
const LOW_SCORE_THRESHOLD = parseFloat(process.env.LLM_JUDGE_LOW_SCORE_THRESHOLD || '2');

// ── Judge prompt ─────────────────────────────────────────────────────────────
// Kept simple on purpose. More elaborate rubrics perform worse on small free
// models than concise ones.
const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluator of a WhatsApp AI assistant named Ari.

Your job: rate how well Ari's response addressed the user's message.

SCORING RUBRIC (1-5):
5 = Perfect — correctly understood intent, took right action, clear answer
4 = Good — mostly right, minor issues
3 = Okay — partially addressed, missing something
2 = Bad — misunderstood intent, wrong tool/action, or incorrect info
1 = Terrible — completely wrong, hallucinated, or harmful

EXAMPLES of bad responses (score 1-2):
- User asks "schedule meeting with John" → Ari sets a reminder instead of a calendar event
- User asks about weather in Delhi → Ari answers about Mumbai
- User's Hindi message → Ari responds in garbled broken English
- User asks due date of bill → Ari hallucinates a date

OUTPUT FORMAT (strict JSON, no other text):
{"score": <1-5>, "reasoning": "<one sentence>"}

Be fair. Short "ok" or greeting replies are fine — score them 4 unless clearly wrong.`;

/**
 * Synchronous sampling decision — returns true if this call should be judged.
 * Using Math.random() is fine; we don't need crypto-grade randomness.
 */
function shouldJudge() {
  if (!ENABLED) return false;
  if (!llm.apiKey()) return false;
  return Math.random() < SAMPLE_RATE;
}

/**
 * Fire-and-forget judge call. Must be called without `await` so it doesn't
 * block the user-facing response.
 *
 * @param {object} params
 * @param {string} params.userId - Ari user phone (wa_*, dc_*, etc.)
 * @param {string} params.userMessage - what the user sent
 * @param {string} params.botResponse - what Ari replied
 * @param {string} [params.traceId] - Langfuse trace ID to attach the score to
 * @param {string} [params.intent] - which intent/tool was picked (optional)
 */
function judgeAsync(params) {
  // Don't await — run in the background. Caller should not block on us.
  setImmediate(() => {
    judge(params).catch(err => {
      // Never let judge errors propagate. Low-signal logging only.
      logger.debug(`llm-judge: skipped (${err.message})`);
    });
  });
}

async function judge({ userId, userMessage, botResponse, traceId, intent }) {
  if (!ENABLED || !llm.apiKey()) return null;

  // Validate inputs so we don't waste Groq credits on garbage.
  if (!userMessage || !botResponse) return null;
  if (userMessage.length > 2000) userMessage = userMessage.slice(0, 2000);
  if (botResponse.length > 2000) botResponse = botResponse.slice(0, 2000);

  const startedAt = Date.now();

  try {
    const response = await axios.post(llm.chatUrl(), {
      model: MODEL,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `USER MESSAGE:\n"${userMessage}"\n\n` +
                   `ARI RESPONSE:\n"${botResponse}"\n\n` +
                   (intent ? `INTENT DETECTED: ${intent}\n\n` : '') +
                   `Score this interaction. Respond with JSON only.`
        }
      ],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' }
    }, {
      headers: llm.headers(),
      timeout: 15000
    });

    const raw = response.data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const score = Number(parsed.score);
    const reasoning = String(parsed.reasoning || '').slice(0, 500);

    if (!Number.isFinite(score) || score < 1 || score > 5) {
      logger.debug(`llm-judge: invalid score returned (${raw})`);
      return null;
    }

    const latencyMs = Date.now() - startedAt;

    // Log the result
    logger.info({
      component: 'llm-judge',
      userId,
      intent,
      score,
      reasoning,
      latencyMs
    }, `LLM judge scored ${score}/5 for ${userId}`);

    // Post score back to Langfuse (fire-and-forget).
    try {
      const { scoreLangfuse } = require('../utils/llm-trace');
      if (traceId && typeof scoreLangfuse === 'function') {
        scoreLangfuse(traceId, score, reasoning);
      } else if (traceId) {
        // Fallback: use the low-level score function exported by llm-trace.
        const llmTrace = require('../utils/llm-trace');
        if (llmTrace.score) llmTrace.score(traceId, score, reasoning);
      }
    } catch (e) { /* noop */ }

    // Low scores → bubble up to Sentry so you get alerted.
    // Using 'error' level (not 'warning') so Sentry's default alert rule emails you.
    // Score 1 = 'error' (urgent), score 2 = 'error' (bad but recoverable).
    if (score <= LOW_SCORE_THRESHOLD) {
      try {
        const { Sentry } = require('../utils/sentry');
        if (Sentry && Sentry.captureMessage) {
          Sentry.captureMessage(
            `Low LLM quality score (${score}/5): ${reasoning}`,
            {
              level: 'error',
              tags: {
                component: 'llm-judge',
                score: String(score),
                intent: intent || 'unknown'
              },
              user: { id: userId },
              extra: {
                userMessage: userMessage.slice(0, 500),
                botResponse: botResponse.slice(0, 500),
                reasoning,
                traceId
              }
            }
          );
        }
      } catch (e) { /* noop */ }
    }

    return { score, reasoning, latencyMs };
  } catch (error) {
    // Groq rate-limit or transient failure — not worth alerting.
    logger.debug(`llm-judge: error (${error.message})`);
    return null;
  }
}

function stats() {
  return {
    enabled: ENABLED,
    sampleRate: SAMPLE_RATE,
    model: MODEL,
    lowScoreThreshold: LOW_SCORE_THRESHOLD,
    hasApiKey: !!llm.apiKey()
  };
}

module.exports = { judgeAsync, judge, shouldJudge, stats };
