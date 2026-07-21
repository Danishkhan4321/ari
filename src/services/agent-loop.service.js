/**
 * Agent Loop — multi-step agentic runtime for Ari.
 *
 * The difference from single-shot intent detection:
 *   Single-shot : user-msg → LLM picks 1 tool → execute → reply
 *   Agent-loop  : user-msg → LLM plans → picks tool A → sees result →
 *                 picks tool B → sees result → … → reply
 *
 * This unlocks requests like "organize my week", "find emails from X and
 * summarise them", "make a reminder for every pending task" — any request
 * that chains multiple tools to reach a goal.
 *
 * Safety rails:
 *   - MAX_STEPS cap so the loop can't run away
 *   - Per-step token budget via max_tokens
 *   - All destructive actions still flow through `confirmation-gate.service`
 *   - Rate-limited per user via `abuse-protection` middleware
 *   - Errors from tools are returned to the LLM (so it can react or retry
 *     with different params), NOT swallowed
 *
 * Model routing:
 *   - Default: GPT-4.1-mini (cheap, fast, good enough for most routing)
 *   - Complex requests auto-route to a stronger model via classifyComplexity()
 *   - Future: can hot-swap to Claude Sonnet / Haiku with one env flag
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { openaiBreaker } = require('../utils/circuit-breakers');
const { llmTrace } = require('../utils/llm-trace');
const llm = require('./llm-provider');
const { normalizeToolResult, serializeToolResult } = require('./tool-result.service');
const {
  BASE_INSTRUCTIONS,
  DEVELOPER_INSTRUCTIONS,
  buildRuntimeContext,
} = require('./ari-agent-policy.service');

// Step cap: if the LLM hasn't returned a final answer by this step, we bail.
// 10 is comfortable for 95% of requests ("organize X", "find Y and do Z", etc.)
// without risking runaway cost. Tune via env if needed.
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '10', 10);

// Per-call timeout — tool loops can take a while; 120s is a sane ceiling.
const OVERALL_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '120000', 10);

// Default models — configurable via env without code changes. Under the
// current provider (Gemini 3 Flash by default) both slots map to the same
// model, so escalation is a no-op unless the user sets AGENT_COMPLEX_MODEL
// to something stronger like `gemini-3-pro-preview`.
// Use modelFor() so MODEL_AGENT_PRIMARY / MODEL_AGENT_ESCALATE env flags take
// precedence. Falls back to AGENT_DEFAULT_MODEL/AGENT_COMPLEX_MODEL or the
// provider's default/complex model if neither is set.
const DEFAULT_MODEL = llm.modelFor('agent_primary') || process.env.AGENT_DEFAULT_MODEL || llm.defaultModel();
const COMPLEX_MODEL = llm.modelFor('agent_escalate') || process.env.AGENT_COMPLEX_MODEL || llm.complexModel();

// HARD KILL SWITCH — if set to 'false', the agent NEVER upgrades to the
// complex model, no matter what. Everything stays on the cheap default.
// Set via env: AGENT_ALLOW_COMPLEX_MODEL=false
const ALLOW_COMPLEX_MODEL = String(process.env.AGENT_ALLOW_COMPLEX_MODEL ?? 'true').toLowerCase() !== 'false';

// Mid-loop escalation: consecutive tool failures are evidence that the cheap
// model is stuck. Successful calls are progress, regardless of chain length.
// The old env name remains a fallback for deployment compatibility.
const ESCALATE_AFTER_FAILURES = parseInt(
  process.env.AGENT_ESCALATE_AFTER_FAILURES || process.env.AGENT_ESCALATE_AFTER_STEPS || '3',
  10
);

/**
 * STATIC prompt — IDENTICAL every call. This is what gets cached on Anthropic
 * (5-min TTL ephemeral cache). Any change to this string busts the cache for
 * every user, so keep it stable. Variables MUST go in buildDynamicContext().
 */
function buildStaticSystemPrompt() {
  return [
    BASE_INSTRUCTIONS,
    DEVELOPER_INSTRUCTIONS,
    'Call tools to do the work rather than describing hypothetical actions. When the work is complete, respond with plain text and no tool call.',
  ].join('\n');
}

/**
 * DYNAMIC context — different every call (timezone, current time, active
 * workflows). Sent as a SEPARATE system message after the cache point so
 * it doesn't bust the cached static prefix. Per-user state goes here.
 */
function buildDynamicContext({ userTimezone, contextHints, nowIso, backgroundBlock }) {
  return buildRuntimeContext({ userTimezone, contextHints, nowIso, backgroundBlock });

  /* istanbul ignore next -- retained temporarily for source compatibility */
  const lines = [
    `For timing, the user is in timezone ${userTimezone || 'Asia/Kolkata'}. Current time: ${nowIso}.`,
  ];
  // Cross-feature background: user profile, today's calendar, pending tasks,
  // relevant memories, and ENTITY CARDS for leads/contacts named in this
  // message (from context-builder + entity-context). This is what lets the
  // loop answer "what's the latest with Meera?" from CRM + meetings + facts
  // without re-asking the user.
  if (backgroundBlock && String(backgroundBlock).trim()) {
    lines.push('', String(backgroundBlock).trim());
  }
  if (contextHints) {
    const ctxBits = [];
    if (contextHints.lastActionRef) {
      const ref = contextHints.lastActionRef;
      ctxBits.push(`Your last action (${ref.ageSec}s ago): ${ref.action} → ${ref.entityType} #${ref.entityId}${ref.label ? ` (“${ref.label}”)` : ''}${ref.targetPhone ? ` for ${ref.targetPhone}` : ''}. If the user refers to "that one" / "the one we just set" / "change the time" etc., they likely mean this.`);
    }
    if (contextHints.hasRecentVisaBatch) {
      ctxBits.push(`The user just saw a list of ${contextHints.recentVisaBatchEmailableCount || 0} visa opportunities. Phrases like "email all of them" / "send to all" refer to that list.`);
    }
    if (contextHints.activeCalendarConfirmation) {
      ctxBits.push(`The user has a pending meeting confirmation. Short replies like "yes" / "no" / "change time to 4pm" apply to THAT meeting.`);
    }
    if (contextHints.activeBulkEmail) {
      ctxBits.push(`There is an active bulk-email draft (${contextHints.bulkEmailRecipientCount} recipients). Edits refer to this draft.`);
    }
    if (ctxBits.length > 0) {
      lines.push('', 'ACTIVE CONTEXT:');
      for (const b of ctxBits) lines.push(`- ${b}`);
    }
  }
  return lines.join('\n');
}

// Backward-compat shim: old callers that just want a single string
function buildSystemPrompt({ userPhone, userTimezone, contextHints, nowIso }) {
  return buildStaticSystemPrompt() + '\n\n' + buildDynamicContext({ userTimezone, contextHints, nowIso });
}

/**
 * Complexity classifier — DELIBERATELY CONSERVATIVE.
 *
 * Defaults to 'simple' (cheap model) for essentially ALL user traffic.
 * Only upgrades pre-emptively when the user VERY explicitly asked for
 * deep reasoning. Otherwise, the mid-loop escalation (see runAgentLoop)
 * is the backstop — it upgrades only if the agent is genuinely stuck.
 *
 * This is intentional: we do NOT want GPT-4.1 leaking onto phrases like
 * "plan a meeting" or "review my reminders" — those are normal traffic.
 *
 * Rule of thumb: if you're not 100% sure this needs the expensive model,
 * return 'simple'. The loop will escalate if it needs to.
 */
function classifyComplexity(userMessage) {
  const t = String(userMessage || '').toLowerCase();

  // Explicit user opt-in to deep reasoning — the only pre-emptive upgrade path.
  // Must be a clear, unambiguous signal that the user WANTS careful thinking.
  const explicitDeepAsk = /\b(think\s+(carefully|deeply|hard)|be\s+(thorough|comprehensive)|deep\s+dive|in[- ]depth\s+analysis|step[- ]by[- ]step\s+plan)\b/.test(t);
  if (explicitDeepAsk) return 'complex';

  // Unusually long requests (>150 words) tend to be multi-part questions
  // that benefit from the better model. Short messages NEVER qualify.
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 150) return 'complex';

  return 'simple';
}

/**
 * Stable signature of a tool_calls array (name + raw arguments, order-
 * insensitive) used by the repeated-call loop guard. Returns null for
 * empty/absent calls so "no tools" never matches "no tools".
 */
function toolCallsSignature(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const parts = toolCalls
    .map((c) => `${c.function?.name || c.name || ''}(${c.function?.arguments || ''})`)
    .sort();
  return parts.join('|');
}

/**
 * A first tool call is not necessarily the whole request. Coordinating words
 * signal that the model may need the observation before it can finish.
 *
 * A bare "and" only counts when it joins two COMMANDS ("create the group and
 * add Priya"), not two nouns ("buy bread and milk", "call Priya and Rahul") —
 * the noun case used to veto the single-tool short-circuit and silently
 * doubled LLM cost/latency on a huge share of ordinary one-tool messages.
 */
const ACTION_VERB_AFTER_AND = /\band\s+(?:then\s+)?(?:also\s+)?(create|add|send|remind|schedule|email|message|text|delete|remove|update|move|change|show|list|assign|book|draft|set|make|call|cancel|reschedule|invite|share|save|note|search|find|check|start|stop|mark|follow|reply|forward|summarize|analy[sz]e|import|export|enrich|track|log)\b/i;

function isLikelyChainedRequest(userMessage) {
  const text = String(userMessage || '');
  if (/\b(then|after that|afterwards|each|for every|one by one)\b/i.test(text)) return true;
  return ACTION_VERB_AFTER_AND.test(text);
}

async function emitAgentEvent(onEvent, runId, event) {
  if (typeof onEvent !== 'function') return;
  try {
    await onEvent({
      runId: runId || null,
      timestamp: new Date().toISOString(),
      ...event,
    });
  } catch (error) {
    logger.warn({ eventType: event?.type, err: error.message }, 'Agent lifecycle event failed');
  }
}

/**
 * Execute one or more tool_calls against the provided tool registry.
 * Returns an array of { tool_call_id, content } role:'tool' messages.
 *
 * @param {Array} toolCalls - OpenAI tool_calls array
 * @param {(name: string, args: object) => Promise<any>} executeFn - runs the tool
 */
async function runToolCalls(toolCalls, executeFn, options = {}) {
  const out = [];
  const collect = (normalized) => {
    if (Array.isArray(options.results)) options.results.push(normalized);
  };
  for (const call of toolCalls) {
    const name = call.function?.name || call.name;
    // A Stop between tool calls must prevent every not-yet-started tool.
    if (options.signal?.aborted) {
      const cancelled = normalizeToolResult({
        status: 'failure',
        error: {
          code: 'agent_cancelled', category: 'execution', retryable: false,
          message: 'The run was stopped before this tool started.',
        },
        user_summary: `${String(name || 'The tool')} was not started because the run was stopped.`,
      }, { toolName: name });
      collect(cancelled);
      out.push({ role: 'tool', tool_call_id: call.id, content: serializeToolResult(cancelled) });
      continue;
    }
    await options.emit?.({
      type: 'tool.started',
      step: options.step,
      toolName: name,
      summary: `Running ${String(name || 'tool').replace(/_/g, ' ')}`,
      payload: {},
    });
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch (e) {
      const normalized = normalizeToolResult({
        status: 'failure',
        error: {
          code: 'invalid_tool_arguments',
          category: 'validation',
          retryable: false,
          message: `Invalid JSON args from LLM: ${e.message}`,
        },
      }, { toolName: name });
      collect(normalized);
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(normalized)
      });
      await options.emit?.({
        type: 'tool.failed', step: options.step, toolName: name,
        summary: `${String(name || 'Tool').replace(/_/g, ' ')} needs corrected inputs`,
        payload: { status: normalized.status, code: normalized.error.code, retryable: false },
      });
      continue;
    }

    try {
      const result = await executeFn(name, args, options.signal ? { signal: options.signal } : {});
      const normalized = normalizeToolResult(result, { toolName: name });
      collect(normalized);
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(normalized)
      });
      const succeeded = normalized.status === 'success';
      await options.emit?.({
        type: succeeded ? 'tool.succeeded' : 'tool.failed',
        step: options.step,
        toolName: name,
        summary: normalized.user_summary
          ? String(normalized.user_summary).slice(0, 180)
          : `${String(name || 'Tool').replace(/_/g, ' ')} ${succeeded ? 'completed' : 'failed'}`,
        payload: {
          status: normalized.status,
          code: normalized.error?.code || null,
          retryable: normalized.error?.retryable === true,
        },
      });
    } catch (err) {
      logger.warn({ tool: name, err: err.message }, 'Agent tool execution failed');
      const normalized = normalizeToolResult({
        status: 'failure',
        error: {
          code: 'tool_execution_error', category: 'execution', retryable: false,
          message: err.message || String(err),
        },
      }, { toolName: name });
      collect(normalized);
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(normalized)
      });
      await options.emit?.({
        type: 'tool.failed', step: options.step, toolName: name,
        summary: `${String(name || 'Tool').replace(/_/g, ' ')} failed`,
        payload: { status: 'failure', code: 'tool_execution_error', retryable: false },
      });
    }
  }
  return out;
}

/**
 * Main entry: run the agentic loop for one user turn.
 *
 * @param {object} opts
 * @param {string} opts.userMessage
 * @param {string} opts.userPhone
 * @param {string} [opts.userTimezone]
 * @param {Array}  opts.tools              - OpenAI tool definitions (reuses tool-definitions.js)
 * @param {(name, args) => Promise<any>} opts.executeFn - tool executor
 * @param {object} [opts.contextHints]     - same shape as getIntentContextHints()
 * @param {Array}  [opts.recentMessages]   - [{role, content}] short recent history
 * @param {string} [opts.model]            - override default model
 * @returns {Promise<{ text: string, steps: number, toolsUsed: string[], latencyMs: number }>}
 */
async function runAgentLoop(opts) {
  const {
    userMessage,
    userPhone,
    userTimezone = 'Asia/Kolkata',
    tools,
    executeFn,
    contextHints = null,
    recentMessages = [],
    model: modelOverride,
    backgroundBlock: backgroundBlockOpt,
    // Optional OpenAI-style tool_choice applied to the FIRST step only —
    // lets the deterministic pre-router force a specific tool
    // ({type:'function', function:{name}}) while later steps stay 'auto'.
    toolChoice = null,
    runId = null,
    onEvent = null,
    // Run-level abort signal (Stop button). Checked between steps, passed to
    // every model call, and forwarded to executeFn so the shared controller
    // boundary can refuse to start new tools after a Stop.
    signal = null
  } = opts;

  const apiKey = llm.apiKey();
  if (!apiKey) throw new Error(`LLM API key not configured for provider=${llm.providerName()}`);
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('agent-loop: tools required');
  if (typeof executeFn !== 'function') throw new Error('agent-loop: executeFn required');

  const complexity = classifyComplexity(userMessage);

  // Resolve the initial model. The HARD KILL SWITCH overrides everything:
  // if AGENT_ALLOW_COMPLEX_MODEL=false, we NEVER touch the expensive model,
  // even when the user explicitly asked for deep reasoning.
  let model;
  if (modelOverride) {
    model = modelOverride;
  } else if (complexity === 'complex' && ALLOW_COMPLEX_MODEL) {
    model = COMPLEX_MODEL;
    logger.info({ userPhone, reason: 'explicit_deep_ask', model }, 'Agent: using complex model (pre-emptive)');
  } else {
    model = DEFAULT_MODEL;
  }

  const nowIso = new Date().toISOString();

  // Cross-feature background block (entity cards, calendar, tasks, memories).
  // Callers may pass their own via opts.backgroundBlock ('' skips); by default
  // we build it here so every agent turn is entity-aware. Fail-open.
  let backgroundBlock = backgroundBlockOpt;
  if (backgroundBlock === undefined) {
    try {
      const contextBuilder = require('./context-builder.service');
      backgroundBlock = await contextBuilder.build(userPhone, userMessage);
    } catch (_) {
      backgroundBlock = '';
    }
  }

  // Split static (cacheable) vs dynamic (per-call) so Anthropic's 5-min cache
  // can hit on the static prefix. _cachePoint flag is honored by
  // bedrock-adapter.service.js → translateMessagesToBedrock.
  const staticSystem = buildStaticSystemPrompt();
  const dynamicSystem = buildDynamicContext({ userTimezone, contextHints, nowIso, backgroundBlock });

  const messages = [
    { role: 'system', content: staticSystem, _cachePoint: true },
    { role: 'system', content: dynamicSystem },
    ...recentMessages
      .filter(m => m && m.role && m.content)
      .slice(-6)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: userMessage }
  ];

  const start = Date.now();
  const toolsUsed = [];
  const toolResults = [];
  let escalated = false;
  let lastCallsSignature = null;
  let consecutiveToolFailures = 0;

  await emitAgentEvent(onEvent, runId, {
    type: 'run.started',
    step: 0,
    summary: 'Understanding your request',
    payload: { complexity, model },
  });

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      const outcome = {
        status: 'cancelled',
        errorCode: 'agent_cancelled',
        text: null,
        steps: step,
        toolsUsed,
        toolResults,
        latencyMs: Date.now() - start,
        finalModel: model
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.cancelled', step, summary: 'The run was stopped',
        payload: { code: outcome.errorCode },
      });
      return outcome;
    }
    // Mid-loop escalation safety net: upgrade only after consecutive tool
    // failures. The length of a healthy tool chain is not a stuck signal.
    if (!escalated && ALLOW_COMPLEX_MODEL && consecutiveToolFailures >= ESCALATE_AFTER_FAILURES && model !== COMPLEX_MODEL) {
      model = COMPLEX_MODEL;
      escalated = true;
      logger.info({
        userPhone,
        step,
        consecutiveToolFailures,
        reason: 'mid_loop_escalation',
        newModel: model
      }, 'Agent: escalating to complex model (agent stuck mid-loop)');
    }
    const elapsedMs = Date.now() - start;
    if (elapsedMs > OVERALL_TIMEOUT_MS) {
      logger.warn({ userPhone, step, elapsedMs }, 'Agent loop hit overall timeout');
      const outcome = {
        status: 'failed',
        errorCode: 'run_timeout',
        text: 'That took longer than expected — try a smaller request?',
        steps: step,
        toolsUsed,
        toolResults,
        latencyMs: elapsedMs,
        finalModel: model
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.failed', step, summary: 'The request timed out',
        payload: { code: outcome.errorCode, retryable: true },
      });
      return outcome;
    }

    // Route via llm.chatCompletion so Bedrock models work transparently.
    // For Gemini/OpenAI it behaves the same as the prior axios call.
    const doCall = () => llm.chatCompletion({
      model,
      messages,
      tools,
      tool_choice: (step === 0 && toolChoice) ? toolChoice : 'auto',
      temperature: 0.1,
      max_tokens: 1500,
      // Gemini defaults are injected via interceptor only for Gemini URL,
      // so sending `reasoning_effort` to Bedrock is safe (Bedrock ignores
      // unknown fields). defaultBodyExtras() returns {} for non-Gemini.
      ...llm.defaultBodyExtras('agent')
    }, {
      task: step === 0 ? 'agent_primary' : (model === COMPLEX_MODEL ? 'agent_escalate' : 'agent_primary'),
      timeout: 30000,
      enablePromptCache: true,
      signal,
    });

    let resp;
    try {
      resp = await llmTrace(
        { name: 'agent_loop.step', userId: userPhone, model, tags: ['agent', `step-${step}`] },
        () => openaiBreaker.fire(doCall)
      );
      // Track usage (leakage/cost audit)
      try {
        const tracker = require('./model-usage-tracker.service');
        const taskName = model === COMPLEX_MODEL ? 'agent_escalate' : 'agent_primary';
        tracker.log({ task: taskName, model, usage: resp?.data?.usage, userPhone });
      } catch (_) {}
    } catch (err) {
      logger.error({ err: err.message, step, userPhone }, 'Agent loop LLM call failed');
      const outcome = {
        status: 'failed',
        errorCode: 'model_error',
        text: err.degraded
          ? 'AI is temporarily unavailable. Try again in 30 seconds.'
          : `Hit an error: ${err.message}`,
        steps: step,
        toolsUsed,
        toolResults,
        latencyMs: Date.now() - start,
        finalModel: model
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.failed', step, summary: 'The AI service is temporarily unavailable',
        payload: { code: outcome.errorCode, retryable: true },
      });
      return outcome;
    }

    if (resp?.degraded) {
      const outcome = {
        status: 'failed',
        errorCode: 'circuit_breaker_open',
        text: 'AI circuit breaker open. Try again shortly.',
        steps: step,
        toolsUsed,
        toolResults,
        latencyMs: Date.now() - start,
        finalModel: model
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.failed', step, summary: 'The AI service is recovering',
        payload: { code: outcome.errorCode, retryable: true },
      });
      return outcome;
    }

    const assistantMsg = resp.data.choices[0].message;
    messages.push(assistantMsg);

    // No tool calls → this is the final reply to the user
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const latencyMs = Date.now() - start;
      logger.info({
        userPhone,
        steps: step + 1,
        toolsUsed,
        latencyMs,
        model,
        complexity,
        escalated,
        complexModelUsed: model === COMPLEX_MODEL
      }, 'Agent loop finished');
      const outcome = {
        status: 'completed',
        text: String(assistantMsg.content || '').trim(),
        steps: step + 1,
        toolsUsed,
        toolResults,
        latencyMs,
        escalated,
        finalModel: model
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.completed', step: step + 1, summary: 'Completed',
        payload: { steps: outcome.steps, toolsUsed: outcome.toolsUsed },
      });
      return outcome;
    }

    // Loop-guard: if the model requests EXACTLY the same tool call(s) with
    // the same arguments as the previous step, don't re-execute — feed back
    // an error so it changes approach or answers. Prevents burn-the-budget
    // retry spirals on a tool that keeps returning something it dislikes.
    const callsSignature = toolCallsSignature(assistantMsg.tool_calls);
    if (callsSignature !== null && callsSignature === lastCallsSignature) {
      logger.warn({ userPhone, step }, 'Agent repeated an identical tool call — injecting guard error');
      for (const tc of assistantMsg.tool_calls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            error: 'Repeated identical tool call blocked. You already have this result — use it, try different arguments, or reply to the user.'
          })
        });
      }
      continue;
    }
    lastCallsSignature = callsSignature;

    // Otherwise, execute each tool the LLM picked and append results
    for (const tc of assistantMsg.tool_calls) {
      toolsUsed.push(tc.function?.name || tc.name);
    }

    await emitAgentEvent(onEvent, runId, {
      type: 'tool.requested',
      step: step + 1,
      summary: assistantMsg.tool_calls.length === 1
        ? `Preparing ${String(assistantMsg.tool_calls[0].function?.name || assistantMsg.tool_calls[0].name || 'tool').replace(/_/g, ' ')}`
        : `Preparing ${assistantMsg.tool_calls.length} actions`,
      payload: { toolNames: assistantMsg.tool_calls.map((tc) => tc.function?.name || tc.name) },
    });
    const toolMessages = await runToolCalls(assistantMsg.tool_calls, executeFn, {
      step: step + 1,
      emit: (event) => emitAgentEvent(onEvent, runId, event),
      results: toolResults,
      signal,
    });
    let pendingUserGate = null;
    for (const tm of toolMessages) {
      messages.push(tm);
      let parsedToolResult;
      try {
        parsedToolResult = JSON.parse(tm.content);
      } catch (_) {
        parsedToolResult = null;
      }
      const failed = parsedToolResult?.status === 'failure' || parsedToolResult?.ok === false;
      consecutiveToolFailures = failed ? consecutiveToolFailures + 1 : 0;
      // A tool that needs the user (a confirmation gate like delete-all, or a
      // clarification) is TERMINAL for this turn. The other two runtimes stop
      // here (openrouter-agent stopsFollowingTools, codex terminalToolResult);
      // the default loop must too, or the model can self-confirm an
      // irreversible action by re-calling the tool with confirm=true on the
      // next step. Surface the tool's question and stop.
      if ((parsedToolResult?.status === 'waiting_input'
        || parsedToolResult?.status === 'waiting_approval')
        && typeof parsedToolResult.user_summary === 'string'
        && parsedToolResult.user_summary.trim()) {
        pendingUserGate = pendingUserGate || {
          status: parsedToolResult.status,
          text: parsedToolResult.user_summary.trim(),
        };
      }
    }
    if (pendingUserGate) {
      const latencyMs = Date.now() - start;
      logger.info({ userPhone, steps: step + 1, toolsUsed, status: pendingUserGate.status },
        'Agent loop stopped on a tool that needs the user (confirmation/clarification)');
      const outcome = {
        status: pendingUserGate.status === 'waiting_approval' ? 'waiting_approval' : 'waiting_for_user',
        text: pendingUserGate.text,
        steps: step + 1,
        toolsUsed,
        toolResults,
        latencyMs,
        finalModel: model,
      };
      await emitAgentEvent(onEvent, runId, {
        type: 'run.completed', step: step + 1, summary: 'Waiting for the user',
        payload: { steps: step + 1, toolsUsed, status: outcome.status },
      });
      return outcome;
    }

    // ─────────────────────────────────────────────────────────────
    // Single-tool short-circuit (the 95% optimization).
    //
    // If this was step 0, exactly ONE tool was called, and that tool
    // returned a formatted user-facing string (which almost all our
    // handlers do), we can skip the second LLM call entirely and
    // send that string straight to the user.
    //
    // Why this matters: single-shot mode had 1 LLM call per request.
    // Without this short-circuit, the agent loop would have 2 (one to
    // pick the tool, one to paraphrase the result). That's a 2×
    // cost + latency regression for the most common case.
    //
    // Chained requests still do the full loop — this optimization only
    // applies when the first tool result can satisfy the whole request.
    // ─────────────────────────────────────────────────────────────
    if (
      step === 0
      && assistantMsg.tool_calls.length === 1
      && toolMessages.length === 1
      && !isLikelyChainedRequest(userMessage)
    ) {
      let parsed;
      try {
        parsed = JSON.parse(toolMessages[0].content);
      } catch (_) { /* fall through to loop */ }

      // Handler returned a formatted user-facing summary (legacy `result`
      // or the typed `user_summary` envelope).
      const userSummary = parsed && typeof parsed.user_summary === 'string'
        ? parsed.user_summary
        : parsed?.result;
      if (parsed && typeof userSummary === 'string' && userSummary.trim().length > 0) {
        // Don't short-circuit if the tool signaled it needs a follow-up
        // (e.g. needsClarification flag, pending workflow, etc.)
        const needsFollowup = parsed.ok === false
          || parsed.status === 'failure'
          || parsed.status === 'partial'
          || parsed.status === 'waiting_approval'
          || parsed.status === 'waiting_input'
          || parsed.needsClarification
          || parsed.needsConfirmation;
        if (!needsFollowup) {
          const latencyMs = Date.now() - start;
          logger.info({
            userPhone,
            steps: 1,
            toolsUsed,
            latencyMs,
            model,
            complexity,
            shortCircuited: true
          }, 'Agent loop short-circuited on single-tool reply');
          const outcome = {
            status: 'completed',
            text: userSummary.trim(),
            steps: 1,
            toolsUsed,
            toolResults,
            latencyMs,
            shortCircuited: true,
            finalModel: model
          };
          await emitAgentEvent(onEvent, runId, {
            type: 'run.completed', step: 1, summary: 'Completed',
            payload: { steps: 1, toolsUsed },
          });
          return outcome;
        }
      }
    }
  }

  // Ran out of steps — emit a best-effort response from the last turn
  logger.warn({ userPhone, MAX_STEPS, toolsUsed }, 'Agent loop exhausted MAX_STEPS');
  const outcome = {
    status: 'failed',
    errorCode: 'max_steps_exhausted',
    text: 'I worked through this but ran out of steps. Can you break the request into smaller parts?',
    steps: MAX_STEPS,
    toolsUsed,
    toolResults,
    latencyMs: Date.now() - start,
    finalModel: model
  };
  await emitAgentEvent(onEvent, runId, {
    type: 'run.failed', step: MAX_STEPS, summary: 'The request needs a smaller scope',
    payload: { code: outcome.errorCode, retryable: false },
  });
  return outcome;
}

module.exports = {
  runAgentLoop,
  classifyComplexity,
  buildDynamicContext,
  toolCallsSignature,
  isLikelyChainedRequest,
  MAX_STEPS
};
