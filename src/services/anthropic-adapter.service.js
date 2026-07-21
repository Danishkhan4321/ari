/**
 * Anthropic Direct adapter — translates OpenAI chat-completion shape →
 * Anthropic Messages API → back to OpenAI shape, so every existing call site
 * (44+ throughout Ari) keeps working unchanged.
 *
 * Why direct (not Bedrock):
 *   - AISPL (India) AWS accounts can't subscribe to Claude on AWS Marketplace
 *     (`INVALID_PAYMENT_INSTRUMENT`). AWS Support case open since early April,
 *     no ETA. Anthropic Direct accepts Indian credit cards at the API level
 *     so this bypasses AWS Marketplace entirely.
 *   - 5% cheaper than OpenRouter (no middleman markup)
 *   - 100-200ms lower latency (one less hop)
 *   - Full prompt-caching support (Anthropic's `cache_control` markers work
 *     reliably; OpenRouter forwarding sometimes drops them)
 *
 * Friendly aliases supported (mirrors bedrock-adapter):
 *   claude-haiku-4.5  → claude-haiku-4-5-20251001
 *   claude-sonnet-4.6 → claude-sonnet-4-6
 *   claude-sonnet-4.5 → claude-sonnet-4-5-20250929
 *   claude-opus-4.6   → claude-opus-4-6
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

// Anthropic model IDs — pinned to specific dated versions where available so
// behavior doesn't shift under us when Anthropic updates a model name.
const ANTHROPIC_MODELS = {
  'claude-haiku-4.5':  'claude-haiku-4-5-20251001',
  'claude-haiku-3.5':  'claude-3-5-haiku-20241022',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'claude-opus-4.6':   'claude-opus-4-6',
};

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot use Anthropic Direct provider');
  _client = new Anthropic({ apiKey });
  logger.info('[Anthropic] client initialized');
  return _client;
}

function isAnthropicAlias(modelOrAlias) {
  if (!modelOrAlias) return false;
  return Object.prototype.hasOwnProperty.call(ANTHROPIC_MODELS, modelOrAlias)
    || /^claude-/.test(modelOrAlias);
}

function resolveModelId(modelOrAlias) {
  if (!modelOrAlias) throw new Error('Anthropic adapter: model required');
  if (ANTHROPIC_MODELS[modelOrAlias]) return ANTHROPIC_MODELS[modelOrAlias];
  // Already a full model ID (e.g. caller passed claude-haiku-4-5-20251001)
  if (modelOrAlias.startsWith('claude-')) return modelOrAlias;
  logger.warn(`[Anthropic] unknown model alias "${modelOrAlias}", using as-is`);
  return modelOrAlias;
}

// ============================================================
// OpenAI → Anthropic translations
// ============================================================

/**
 * OpenAI messages → Anthropic Messages API format.
 *   OpenAI: [{role: 'system'|'user'|'assistant', content: '...'}]
 *   Anthropic: top-level `system` string + `messages: [{role: 'user'|'assistant', content: ...}]`
 */
function translateMessagesToAnthropic(openaiMessages) {
  // System is built as an array of blocks so callers can request a
  // cache breakpoint between blocks via `_cachePoint: true`. If no
  // marker is present, downstream code joins/wraps as a single block.
  const systemBlocks = [];
  const messages = [];

  for (const msg of openaiMessages || []) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const block = { type: 'text', text };
      // Honor explicit cache marker — see agent-loop.service.js. The
      // static system prompt is marked so Anthropic caches everything
      // up to and including it (5-min ephemeral). Dynamic context that
      // follows (timezone, current time, active workflow hints) stays
      // fresh and does NOT bust the cache.
      if (msg._cachePoint) block.cache_control = { type: 'ephemeral' };
      systemBlocks.push(block);
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    let content;

    if (Array.isArray(msg.content)) {
      // Multimodal — convert OpenAI image_url blocks to Anthropic image blocks
      content = msg.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'image_url') {
          const url = block.image_url?.url || '';
          const m = url.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,(.+)$/i);
          if (m) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: `image/${m[1].toLowerCase().replace('jpg', 'jpeg')}`,
                data: m[2],
              },
            };
          }
          // External URL — Anthropic supports url-source images now
          return { type: 'image', source: { type: 'url', url } };
        }
        return null;
      }).filter(Boolean);
    } else {
      content = String(msg.content || '');
    }

    messages.push({ role, content });
  }

  return {
    // Return either an array of blocks (preserves cache_control markers)
    // or undefined. chatCompletion auto-wraps single-block arrays for
    // caching when enablePromptCache=true.
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages,
  };
}

/**
 * OpenAI tools → Anthropic tools.
 *   OpenAI:    [{type:'function', function:{name, description, parameters: JSONSchema}}]
 *   Anthropic: [{name, description, input_schema: JSONSchema}]
 */
function translateToolsToAnthropic(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return openaiTools.map(t => ({
    name: t.function?.name,
    description: t.function?.description || '',
    input_schema: t.function?.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * OpenAI tool_choice → Anthropic tool_choice.
 *   OpenAI: 'auto' | 'none' | 'required' | {type:'function', function:{name}}
 *   Anthropic: {type:'auto'} | {type:'none'} | {type:'any'} | {type:'tool', name}
 */
function translateToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return undefined;
}

// ============================================================
// Anthropic → OpenAI translation (the critical one)
// ============================================================

/**
 * Anthropic Messages response → OpenAI chat-completion shape.
 * Every caller reads `response.data.choices[0].message.{content, tool_calls}`.
 */
function translateResponseToOpenAI(anthropicResponse, modelId) {
  const blocks = anthropicResponse.content || [];
  const textParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name: block.name,
          // OpenAI expects arguments as a JSON-stringified string
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const stopReason = anthropicResponse.stop_reason || 'end_turn';
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'max_tokens' ? 'length'
    : 'stop';

  const usage = anthropicResponse.usage || {};

  return {
    data: {
      id: anthropicResponse.id || `anthropic_${Date.now()}`,
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
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        // Surface cache hit/write counters so cost-tracking can see them
        ...(usage.cache_read_input_tokens && { cache_read_input_tokens: usage.cache_read_input_tokens }),
        ...(usage.cache_creation_input_tokens && { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
      },
    },
  };
}

// ============================================================
// Main entry
// ============================================================

/**
 * OpenAI-compatible chat completion against Anthropic Direct.
 *
 * @param {object} openaiRequest  Same shape as posting to OpenAI: model,
 *                                messages, tools, tool_choice, temperature,
 *                                max_tokens, top_p, stop.
 * @param {object} [opts]         { timeout, enablePromptCache }
 * @returns                        { data: { choices: [...], usage: {...} } }
 *                                 Same shape as axios.post to OpenAI.
 */
async function chatCompletion(openaiRequest, opts = {}) {
  // H3-N fix (Batch F4): wrap the actual SDK call in a circuit breaker.
  // Was previously direct, so an Anthropic 503 outage stalled every Claude
  // call 45s before erroring; now we fail fast and the fallback chain (if
  // OPT_FALLBACK_CHAIN_ENABLED) can hop to another provider.
  const { anthropicBreaker } = require('../utils/circuit-breakers');
  return anthropicBreaker.fire(async () => _chatCompletionInner(openaiRequest, opts));
}

async function _chatCompletionInner(openaiRequest, opts = {}) {
  const { model, messages, tools, tool_choice, temperature, max_tokens, top_p, stop } = openaiRequest;
  const { timeout = 45000, enablePromptCache = false } = opts;

  const client = getClient();
  const modelId = resolveModelId(model);
  const { system, messages: anthropicMessages } = translateMessagesToAnthropic(messages);
  const anthropicTools = translateToolsToAnthropic(tools);
  const anthropicToolChoice = translateToolChoiceToAnthropic(tool_choice);

  // Prompt caching — when enabled, mark the system prompt + tool definitions
  // as cacheable so Anthropic charges 90% less on cache hits.
  //
  // `system` is now ALWAYS an array of `{type:'text', text, cache_control?}`
  // blocks (or undefined). If at least one block already has cache_control
  // (placed via `_cachePoint: true` on a system message — see agent-loop),
  // pass through as-is so the caller's chosen breakpoint is preserved.
  // Otherwise, when `enablePromptCache` is true and there's no explicit
  // marker, mark the LAST block as cacheable so legacy callers still benefit.
  let systemForRequest = system;
  if (Array.isArray(system) && system.length > 0) {
    const hasMarker = system.some(b => b && b.cache_control);
    if (!hasMarker && enablePromptCache) {
      systemForRequest = system.map((b, i) => (
        i === system.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b
      ));
    }
  }

  // max_tokens is REQUIRED by Anthropic (unlike OpenAI). Default to a
  // reasonable cap for tool-calling routes when caller forgot to set it.
  const safeMaxTokens = Math.min(max_tokens || 1024, 8192);

  // Sampling parameters were REMOVED on the current model generation — Sonnet 5,
  // Opus 4.7/4.8, and Fable 5 answer `temperature is deprecated for this model`
  // with a 400. Every Ari call site sends temperature, so without this strip a
  // switch to any of those models fails on 100% of turns. Older models
  // (Sonnet 4.6, Opus 4.6, Haiku 4.5) still accept them.
  const rejectsSampling = /^claude-(sonnet-5|opus-4-(7|8)|fable-5|mythos-5)/.test(modelId);

  const requestBody = {
    model: modelId,
    max_tokens: safeMaxTokens,
    messages: anthropicMessages,
    ...(systemForRequest && { system: systemForRequest }),
    ...(anthropicTools && { tools: anthropicTools }),
    ...(anthropicToolChoice && { tool_choice: anthropicToolChoice }),
    ...(!rejectsSampling && temperature != null && { temperature }),
    ...(!rejectsSampling && top_p != null && { top_p }),
    ...(stop && { stop_sequences: Array.isArray(stop) ? stop : [stop] }),
  };

  try {
    const response = await client.messages.create(requestBody, {
      timeout,
      // No retry — circuit breakers + caller-side retry handle this
      maxRetries: 0,
    });
    return translateResponseToOpenAI(response, modelId);
  } catch (error) {
    // Normalize Anthropic SDK errors into axios-shaped errors so the existing
    // try/catch + circuit breaker code keeps working unchanged.
    const status = error.status || error.statusCode || 500;
    const message = error.message || 'Anthropic call failed';
    const normalized = new Error(`[Anthropic] ${status}: ${message}`);
    normalized.response = {
      status,
      data: { error: { message, type: error.error?.type, code: error.error?.code } },
    };
    logger.error(`[Anthropic] ${modelId} error (${status}): ${message}`);
    throw normalized;
  }
}

module.exports = {
  chatCompletion,
  resolveModelId,
  isAnthropicAlias,
  ANTHROPIC_MODELS,
};
