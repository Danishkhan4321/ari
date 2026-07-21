/**
 * AWS Bedrock adapter — translates OpenAI chat-completion shape → Bedrock
 * Converse API, so the 44 call sites throughout Ari don't need to change.
 *
 * Design principles (from migration audit — see previous session):
 *   1. Preserve the exact OpenAI response shape callers already parse
 *      (choices[0].message.{content, tool_calls}, tool_calls[0].function.arguments)
 *   2. Never throw on recoverable errors — always return a normalized shape
 *      so the circuit breaker + graceful fallback machinery keeps working.
 *   3. Support prompt caching via Bedrock's `cachePoint` markers.
 *   4. Support batch API opt-in (future — not in this initial build).
 *
 * What this does NOT do yet (deferred to a later phase):
 *   - Streaming (Ari doesn't stream anywhere — audit confirmed)
 *   - Batch Inference (adds 50% discount; wired in Phase 6+)
 *   - Cross-region failover (us-east-1 default only; add later)
 *
 * Error shape: we throw axios-like errors with `error.response.status`
 * so existing retry / circuit-breaker logic sees the same shape it's
 * used to for OpenAI/Gemini errors.
 */

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const logger = require('../utils/logger');

// ============================================================
// BEDROCK MODEL IDS — pinned to specific versions for stability
// ============================================================

// Anthropic Claude (tool-calling + writing + vision)
// IMPORTANT: This account is AISPL (Amazon Web Services India Private Limited).
// AISPL accounts cannot access `us.*` Claude inference profiles because those
// route through the US AWS Marketplace, which blocks AISPL card payments for
// contract-pricing products (INVALID_PAYMENT_INSTRUMENT error).
// Instead, we use the `global.*` inference profile from ap-south-1 (Mumbai) —
// AWS's official India pathway that bills through AISPL directly.
// Reference: https://aws.amazon.com/blogs/machine-learning/access-anthropic-claude-models-in-india-on-amazon-bedrock-with-global-cross-region-inference/
// For Nova, the `apac.*` inference profile is the India equivalent of `us.*`.
const BEDROCK_MODELS = {
  // Claude — global cross-Region inference profiles (India-friendly, verified April 2026)
  // NOTE: Currently blocked on AISPL (INVALID_PAYMENT_INSTRUMENT) — AWS Support case 177695291100244 pending.
  'claude-haiku-4.5':  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku-3.5':  'global.anthropic.claude-3-5-haiku-20241022-v1:0',
  'claude-sonnet-4.6': 'global.anthropic.claude-sonnet-4-6',
  'claude-sonnet-4.5': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-opus-4.6':   'global.anthropic.claude-opus-4-6-v1',

  // Amazon Nova — APAC cross-Region inference profiles (routed via Mumbai)
  'nova-micro': 'apac.amazon.nova-micro-v1:0',
  'nova-lite':  'apac.amazon.nova-lite-v1:0',
  'nova-pro':   'apac.amazon.nova-pro-v1:0',
  'nova-premier': 'apac.amazon.nova-premier-v1:0',

  // Mistral — Option C hybrid stack primary tier. Hosted in us-east-1 on AISPL.
  'mistral-large-3':   'mistral.mistral-large-3-675b-instruct',
  'ministral-3-14b':   'mistral.ministral-3-14b-instruct',
  'ministral-3-8b':    'mistral.ministral-3-8b-instruct',
  'ministral-3-3b':    'mistral.ministral-3-3b-instruct',
  'pixtral-large':     'mistral.pixtral-large-2502-v1:0',

  // Meta Llama — us-east-1 cross-Region inference profile.
  // Added April 2026 for intent-routing cost-quality experiments.
  'llama-3.3-70b':     'us.meta.llama3-3-70b-instruct-v1:0',

  // OpenAI GPT-OSS (open-weights Bedrock offering) — used for visa resume parse etc.
  'gpt-oss-120b':      'openai.gpt-oss-120b-1:0',
  'gpt-oss-20b':       'openai.gpt-oss-20b-1:0',

  // Amazon Titan embeddings (no inference profile needed — embedding endpoint)
  'titan-embed': 'amazon.titan-embed-text-v2:0',
};

// Per-region client cache. An AISPL (India) account needs two regions because:
//   - Claude `global.*` profiles are only subscribable from ap-south-2 (Hyderabad)
//     without triggering INVALID_PAYMENT_INSTRUMENT (Mumbai is blocked).
//   - Nova `apac.*` profiles live in ap-south-1 (Mumbai); they are not published
//     in ap-south-2.
// Use the model ID itself to pick the right region. Callers don't need to know.
const _bedrockClients = new Map();

function regionForModelId(modelId) {
  // Explicit per-call override (rarely used): BEDROCK_REGION_OVERRIDE
  if (process.env.BEDROCK_REGION_OVERRIDE) return process.env.BEDROCK_REGION_OVERRIDE;

  // Per-model routing — IGNORES global AWS_REGION so the rest of the
  // app can still use AWS_REGION=us-east-1 (or whatever) for non-Bedrock
  // AWS services (S3, DynamoDB, etc.) without breaking Bedrock calls.
  if (!modelId) return 'ap-south-2';
  const id = String(modelId).toLowerCase();
  if (id.startsWith('global.anthropic') || id.includes('anthropic.claude')) return 'ap-south-2';
  if (id.startsWith('apac.amazon') || id.includes('amazon.nova')) return 'ap-south-1';
  if (id.includes('amazon.titan-embed')) return 'ap-south-1';
  // Mistral + OpenAI GPT-OSS live in us-east-1 on AISPL (no APAC inference profile yet)
  if (id.includes('mistral.') || id.includes('openai.gpt-oss')) return 'us-east-1';
  // Meta Llama — us-east-1 cross-Region inference profile (us. prefix).
  if (id.includes('meta.')) return 'us-east-1';
  return 'ap-south-2';
}

function getBedrockClient(modelId) {
  const region = regionForModelId(modelId);
  if (_bedrockClients.has(region)) return _bedrockClients.get(region);
  const client = new BedrockRuntimeClient({
    region,
    maxAttempts: 1, // we handle retries at the circuit-breaker layer
  });
  _bedrockClients.set(region, client);
  logger.info(`[Bedrock] client initialized (region=${region})`);
  return client;
}

// ============================================================
// SHAPE TRANSLATION
// ============================================================

/**
 * Resolve a model alias or full Bedrock model ID.
 * Accepts both "claude-haiku-4.5" (friendly) and "us.anthropic.claude-..."
 * (raw Bedrock ID) so callers can be explicit or use the alias.
 */
function resolveModelId(modelOrAlias) {
  if (!modelOrAlias) throw new Error('Bedrock adapter: model required');
  if (BEDROCK_MODELS[modelOrAlias]) return BEDROCK_MODELS[modelOrAlias];
  // Already a full model ID
  if (modelOrAlias.includes('.') && modelOrAlias.includes(':')) return modelOrAlias;
  // Unknown alias
  logger.warn(`[Bedrock] unknown model alias "${modelOrAlias}", using as-is`);
  return modelOrAlias;
}

/**
 * OpenAI messages → Bedrock Converse messages.
 *
 * OpenAI shape:           Bedrock shape:
 *   [{role: 'system'|      system = [{text: '...'}]  (top-level, not in messages)
 *     'user'|'assistant',  messages = [{role: 'user'|'assistant',
 *    content: '...'}]                    content: [{text: '...'}]}]
 */
function translateMessagesToBedrock(openaiMessages) {
  const systemMessages = [];
  const bedrockMessages = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      // Bedrock takes system as separate top-level field (not a message)
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      systemMessages.push({ text });
      // Honor explicit cache marker: callers (e.g., agent-loop) place
      // `_cachePoint: true` on the LAST static system message so Anthropic
      // caches everything up to and including it. Anything that follows
      // (dynamic context, recent history, current user turn) stays fresh.
      if (msg._cachePoint) {
        systemMessages.push({ cachePoint: { type: 'default' } });
      }
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = [];

    if (Array.isArray(msg.content)) {
      // Multimodal content — images, text blocks
      for (const block of msg.content) {
        if (block.type === 'text') content.push({ text: block.text });
        else if (block.type === 'image_url') {
          // OpenAI image_url -> Bedrock image block
          // Bedrock wants raw bytes base64; OpenAI passes data URL or URL
          const url = block.image_url?.url || '';
          const match = url.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,(.+)$/i);
          if (match) {
            content.push({
              image: {
                format: match[1].toLowerCase().replace('jpg', 'jpeg'),
                source: { bytes: Buffer.from(match[2], 'base64') },
              },
            });
          } else {
            logger.warn('[Bedrock] image_url passthrough not supported; use base64 data URLs');
          }
        }
      }
    } else {
      // Plain string content
      content.push({ text: String(msg.content || '') });
    }

    if (content.length > 0) {
      bedrockMessages.push({ role, content });
    }
  }

  return { system: systemMessages, messages: bedrockMessages };
}

/**
 * OpenAI tools → Bedrock toolConfig.
 * OpenAI tools are [{type:'function', function:{name, description, parameters:JSONSchema}}]
 * Bedrock tools are {tools: [{toolSpec: {name, description, inputSchema:{json:...}}}]}
 */
function translateToolsToBedrock(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return null;
  return {
    tools: openaiTools.map(t => ({
      toolSpec: {
        name: t.function?.name,
        description: t.function?.description || '',
        inputSchema: { json: t.function?.parameters || { type: 'object', properties: {} } },
      },
    })),
  };
}

/**
 * Bedrock response → OpenAI chat-completion shape.
 * This is the CRITICAL translation — every caller reads
 * response.data.choices[0].message.{content, tool_calls}.
 */
function translateResponseToOpenAI(bedrockOutput, modelId) {
  const output = bedrockOutput.output || {};
  const assistantMsg = output.message || { content: [] };

  let textParts = [];
  let toolCalls = [];

  for (const block of (assistantMsg.content || [])) {
    if (block.text) textParts.push(block.text);
    else if (block.toolUse) {
      // Bedrock toolUse → OpenAI tool_calls
      toolCalls.push({
        id: block.toolUse.toolUseId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name: block.toolUse.name,
          // OpenAI expects arguments as a JSON-stringified string
          arguments: JSON.stringify(block.toolUse.input || {}),
        },
      });
    }
  }

  const usage = bedrockOutput.usage || {};
  const stopReason = bedrockOutput.stopReason || 'end_turn';
  // Map stop reason to OpenAI finish_reason
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'max_tokens' ? 'length'
    : 'stop';

  return {
    data: {
      id: `bedrock_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textParts.length > 0 ? textParts.join('\n') : null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        total_tokens: usage.totalTokens || 0,
        // Bedrock cache telemetry — both fields are present only when the
        // model and account support prompt caching (Anthropic via Bedrock).
        // cache_read = served from cache (cheap, ~10% input price)
        // cache_write = wrote to cache this turn (expensive, ~125% input price)
        ...(usage.cacheReadInputTokens && { cache_read_input_tokens: usage.cacheReadInputTokens }),
        ...(usage.cacheWriteInputTokens && { cache_creation_input_tokens: usage.cacheWriteInputTokens }),
      },
    },
  };
}

// ============================================================
// MAIN ENTRY
// ============================================================

/**
 * OpenAI-compatible chat completion against AWS Bedrock.
 *
 * @param {object} openaiRequest  Body as if sending to OpenAI (model, messages, tools, etc.)
 * @param {object} [opts]         { timeout, region, enablePromptCache }
 * @returns                        { data: { choices: [...], usage: {...} } }
 *                                 Same shape as axios.post to OpenAI.
 */
async function chatCompletion(openaiRequest, opts = {}) {
  // H3-N fix (Batch F4): same as anthropic-adapter — wrap in circuit
  // breaker so Bedrock outages fail fast instead of stalling.
  const { bedrockBreaker } = require('../utils/circuit-breakers');
  return bedrockBreaker.fire(async () => _chatCompletionInner(openaiRequest, opts));
}

async function _chatCompletionInner(openaiRequest, opts = {}) {
  const { model, messages, tools, tool_choice, temperature, max_tokens, top_p, stop } = openaiRequest;
  const { timeout = 45000, enablePromptCache = false } = opts;

  const modelId = resolveModelId(model);
  const { system, messages: bedrockMessages } = translateMessagesToBedrock(messages);
  const toolConfig = translateToolsToBedrock(tools);

  // Prompt-caching markers — Anthropic via Bedrock supports `cachePoint`
  // blocks. We add one after the system prompt if enabled (intent detection
  // and agent-loops are the biggest beneficiaries — big static system prompt).
  // If the caller already placed an explicit cachePoint via _cachePoint:true
  // on a system message, don't add a duplicate at the end (would split into
  // two cache breakpoints — wastes one of Anthropic's 4 limits and rebuilds
  // the dynamic-context portion as a 2nd cache layer for nothing).
  if (enablePromptCache && system.length > 0 && modelId.includes('anthropic')) {
    const hasCachePoint = system.some(s => s && s.cachePoint);
    if (!hasCachePoint) {
      system.push({ cachePoint: { type: 'default' } });
    }
  }

  const command = new ConverseCommand({
    modelId,
    ...(system.length > 0 && { system }),
    messages: bedrockMessages,
    ...(toolConfig && { toolConfig }),
    inferenceConfig: {
      ...(max_tokens && { maxTokens: Math.min(max_tokens, 8192) }),
      ...(temperature != null && { temperature }),
      ...(top_p != null && { topP: top_p }),
      ...(stop && { stopSequences: Array.isArray(stop) ? stop : [stop] }),
    },
  });

  try {
    const client = getBedrockClient(modelId);
    // AbortController for timeout support
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), timeout);
    try {
      const response = await client.send(command, { abortSignal: ac.signal });
      return translateResponseToOpenAI(response, modelId);
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const httpStatus = mapBedrockErrorToHttp(error);
    const isThrottle = httpStatus === 429 || error.name === 'ThrottlingException';
    const isUnavailable = httpStatus === 503 || error.name === 'ServiceUnavailableException';

    // ── PRODUCTION RESILIENCE — automatic fallback on throttle ──
    // When Mistral Large 3 hits its 100-RPM cap (or Nova throttles), retry
    // ONCE on a different-quota model so users get a response instead of a
    // hard fail. Mistral → Nova Pro is the safest swap (similar quality on
    // intent detection, separate Bedrock quota pool).
    //
    // Skipped if: opts.noFallback is set, or we already retried, or the
    // failure isn't throttle-related (e.g. ValidationException — fallback
    // wouldn't help).
    const fallbackModelAlias = pickFallbackModel(model);
    const canRetry = (isThrottle || isUnavailable)
                  && !opts.noFallback
                  && !opts._isFallback
                  && fallbackModelAlias
                  && fallbackModelAlias !== model;

    if (canRetry) {
      logger.warn(`[Bedrock] ${modelId} throttled (${httpStatus}) — falling back to ${fallbackModelAlias}`);
      try {
        return await chatCompletion(
          { ...openaiRequest, model: fallbackModelAlias },
          { ...opts, _isFallback: true, timeout: Math.max(timeout - 2000, 8000) }
        );
      } catch (fallbackErr) {
        logger.error(`[Bedrock] fallback ${fallbackModelAlias} also failed: ${fallbackErr.message}`);
        // Fall through to throw the ORIGINAL error so callers see the throttle, not the fallback miss.
      }
    }

    // Normalize Bedrock errors into an axios-like shape so existing
    // error-handling branches (status 429/503, error.degraded) keep working.
    const normalized = new Error(error.message || 'Bedrock chat completion failed');
    normalized.response = {
      status: httpStatus,
      data: { error: { message: error.message, name: error.name } },
    };
    normalized.name = error.name || 'BedrockError';
    logger.error(`[Bedrock] ${modelId} error (${normalized.response.status}): ${error.message}`);
    throw normalized;
  }
}

/**
 * Pick a fallback model when the primary throttles. Routes to a model in a
 * different quota pool (different model family or region) so we're not just
 * banging on the same exhausted quota.
 *
 * Returns null if no good fallback exists for this model.
 */
function pickFallbackModel(primaryAlias) {
  // Mistral throttles → Nova Pro (separate quota, multimodal-capable, decent tool calling)
  if (primaryAlias === 'mistral-large-3') return 'nova-pro';
  if (primaryAlias === 'pixtral-large')   return 'nova-pro';
  // Nova throttles → Nova Lite (same family but lower-tier, separate quota in some regions)
  if (primaryAlias === 'nova-pro')        return 'nova-lite';
  if (primaryAlias === 'nova-lite')       return 'nova-micro';
  // Ministral throttles → Nova Micro (cheap classifier-tier swap)
  if (primaryAlias === 'ministral-3-3b')  return 'nova-micro';
  if (primaryAlias === 'ministral-3-14b') return 'nova-micro';
  // Claude throttles → Mistral Large 3 (similar tool-calling quality, different quota)
  if (primaryAlias === 'claude-haiku-4.5')  return 'mistral-large-3';
  if (primaryAlias === 'claude-sonnet-4.6') return 'mistral-large-3';
  // GPT-OSS throttles → no good fallback (used for visa resume parse only)
  return null;
}

/**
 * Map a Bedrock error object to a plausible HTTP status code so callers
 * that inspect error.response.status (which they do — see ai.service 1108)
 * don't need to be changed.
 */
function mapBedrockErrorToHttp(error) {
  const name = error.name || '';
  if (name === 'ThrottlingException') return 429;
  if (name === 'ServiceUnavailableException') return 503;
  if (name === 'ValidationException') return 400;
  if (name === 'AccessDeniedException') return 403;
  if (name === 'ResourceNotFoundException') return 404;
  if (name === 'ModelErrorException') return 500;
  if (name === 'ModelTimeoutException') return 504;
  return error.$metadata?.httpStatusCode || 500;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  chatCompletion,
  resolveModelId,
  BEDROCK_MODELS,
  _internal: {
    translateMessagesToBedrock,
    translateToolsToBedrock,
    translateResponseToOpenAI,
  },
};
