/**
 * Central LLM provider configuration.
 *
 * One source of truth for *every* LLM call in Ari. Pick the provider once
 * via the `LLM_PROVIDER` env var and every service (raw-axios call sites AND
 * Vercel AI SDK call sites) routes there automatically.
 *
 * Current default: Gemini 3 Flash Preview (user's decision — beats
 *   2.5-pro on Hindi/Arabic, 1M context, 3× faster, $0.50 / $3.00 per 1M).
 *
 * Kept: OpenAI and Groq paths, so rollback is one env-var flip (safety net).
 *
 * Usage patterns
 * --------------
 * Raw axios call sites:
 *   const llm = require('./llm-provider');
 *   await axios.post(llm.chatUrl(), { model: llm.defaultModel(), ... },
 *                    { headers: llm.headers() });
 *
 * Vercel AI SDK call sites:
 *   const llm = require('./llm-provider');
 *   await generateObject({ model: llm.sdkModel(), schema, prompt });
 *
 * Env vars
 * --------
 *   LLM_PROVIDER       = gemini | openai | groq   (default: gemini)
 *   GEMINI_API_KEY     = Google AI Studio key      (for provider=gemini)
 *   GEMINI_MODEL       = default chat model        (default: gemini-3-flash-preview)
 *   GEMINI_FAST_MODEL  = classification / fast     (default: GEMINI_MODEL)
 *   GEMINI_COMPLEX_MODEL = heavy reasoning         (default: GEMINI_MODEL)
 *   OPENAI_API_KEY / OPENAI_MODEL / OPENAI_FAST_MODEL / OPENAI_COMPLEX_MODEL
 *   GROQ_API_KEY / GROQ_MODEL
 */

const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { openai, createOpenAI } = require('@ai-sdk/openai');
const axios = require('axios');
const logger = require('../utils/logger');

const RAW_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const PROVIDER = ['vertex', 'google_vertex', 'vertex_gemma'].includes(RAW_PROVIDER)
  ? 'vertex_gemma'
  : RAW_PROVIDER;

// --- Endpoint URLs (OpenAI-compatible chat completions) ---
const FIREWORKS_CHAT_URL = `${(process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/+$/, '')}/chat/completions`;
const GEMINI_CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_CHAT_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;
const DEFAULT_FIREWORKS_FALLBACK_MODEL = 'accounts/fireworks/models/qwen3p7-plus';

function vertexProjectId() {
  return process.env.GOOGLE_VERTEX_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || process.env.GCP_PROJECT
    || process.env.VERTEX_PROJECT_ID;
}

function vertexCredentials() {
  const raw = process.env.GOOGLE_VERTEX_CREDENTIALS;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (_) {
      return null;
    }
  }
}

function vertexLocation() {
  return process.env.GOOGLE_VERTEX_LOCATION || process.env.VERTEX_LOCATION || 'global';
}

// Vertex's OpenAI-compatible endpoint addresses Google-published models as
// `google/<model>` — both Gemma MaaS and first-party Gemini (which is the
// strong native tool-caller; Gemma's tool calling is best-effort).
function vertexOpenApiModelName(modelName) {
  const model = String(modelName || '').trim();
  if (!model || model.includes('/')) return model;
  if (/^(gemma-|gemini-)/i.test(model)) return `google/${model}`;
  return model;
}

function normalizeVertexGemmaModel(modelName) {
  const model = String(modelName || '').trim();
  const bareModel = model.includes('/') ? model.split('/').pop() : model;
  if (/^(gemma-|gemini-)/i.test(bareModel)) return model;
  return defaultModel();
}

function vertexGemmaOpenAIBaseUrl() {
  const project = vertexProjectId() || 'missing-google-cloud-project';
  const location = vertexLocation();
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com/v1'
    : `https://${location}-aiplatform.googleapis.com/v1`;
  return `${host}/projects/${project}/locations/${location}/endpoints/openapi`;
}

const VERTEX_GEMMA_OPENAI_BASE_URL = (process.env.VERTEX_GEMMA_BASE_URL || vertexGemmaOpenAIBaseUrl()).replace(/\/+$/, '');
const VERTEX_GEMMA_CHAT_URL = process.env.VERTEX_GEMMA_CHAT_URL || `${VERTEX_GEMMA_OPENAI_BASE_URL}/chat/completions`;
// Bedrock has no single URL (AWS SDK handles signing + region routing).
// We keep a sentinel so existing axios-interceptor code that compares to
// chatUrl() doesn't accidentally intercept Bedrock calls.
const BEDROCK_CHAT_URL_SENTINEL = 'bedrock://converse';

// --- Default models per provider ---
const DEFAULTS = {
  vertex_gemma: {
    default: process.env.VERTEX_GEMMA_MODEL || 'gemma-4-26b-a4b-it-maas',
    fast:    process.env.VERTEX_GEMMA_FAST_MODEL || process.env.VERTEX_GEMMA_MODEL || 'gemma-4-26b-a4b-it-maas',
    complex: process.env.VERTEX_GEMMA_COMPLEX_MODEL || process.env.VERTEX_GEMMA_MODEL || 'gemma-4-26b-a4b-it-maas'
  },
  fireworks: {
    default: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/gemma-4-26b-a4b-it',
    fast:    process.env.FIREWORKS_FAST_MODEL || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/gemma-4-26b-a4b-it',
    complex: process.env.FIREWORKS_COMPLEX_MODEL || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/gemma-4-31b-it'
  },
  gemini: {
    default: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    fast:    process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    complex: process.env.GEMINI_COMPLEX_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
  },
  openai: {
    default: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    fast:    process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    complex: process.env.OPENAI_COMPLEX_MODEL || 'gpt-4.1'
  },
  openrouter: {
    default: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
    fast: process.env.OPENROUTER_FAST_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
    complex: process.env.OPENROUTER_COMPLEX_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4.1'
  },
  groq: {
    default: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    fast:    process.env.GROQ_FAST_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    complex: process.env.GROQ_COMPLEX_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  },
  bedrock: {
    // Defaults here are the friendly aliases from bedrock-adapter.service.js
    // Callers that want to pin exact model IDs can set BEDROCK_DEFAULT_MODEL etc.
    default: process.env.BEDROCK_DEFAULT_MODEL || 'claude-haiku-4.5',
    fast:    process.env.BEDROCK_FAST_MODEL    || 'nova-lite',
    complex: process.env.BEDROCK_COMPLEX_MODEL || 'claude-sonnet-4.6'
  }
};

// Resolve which provider is actually usable (fall back if key missing).
//
// For Bedrock we TRUST the user's config: the AWS SDK's default credential
// chain walks env → ~/.aws/credentials → EC2/ECS instance metadata, so
// refusing to pick 'bedrock' just because AWS_ACCESS_KEY_ID isn't an env var
// silently breaks every dev machine that uses `aws configure`. If the creds
// are actually missing, the first Bedrock call will surface a clear error.
function resolveProvider() {
  if (PROVIDER === 'vertex_gemma') return 'vertex_gemma';
  if (PROVIDER === 'bedrock') return 'bedrock';
  if (PROVIDER === 'fireworks' && process.env.FIREWORKS_API_KEY) return 'fireworks';
  if (PROVIDER === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (PROVIDER === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (PROVIDER === 'openrouter' && process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (PROVIDER === 'groq'   && process.env.GROQ_API_KEY)   return 'groq';
  // Requested provider unusable — fall back in this order.
  if (process.env.FIREWORKS_API_KEY) return 'fireworks';
  if (vertexProjectId()) return 'vertex_gemma';
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_EXECUTION_ENV) return 'bedrock';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GROQ_API_KEY)   return 'groq';
  return PROVIDER; // will no-op later when key is missing
}

const ACTIVE = resolveProvider();

function apiKey() {
  if (ACTIVE === 'vertex_gemma') return process.env.GOOGLE_VERTEX_ACCESS_TOKEN || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'vertex-adc';
  if (ACTIVE === 'fireworks') return process.env.FIREWORKS_API_KEY;
  if (ACTIVE === 'gemini') return process.env.GEMINI_API_KEY;
  if (ACTIVE === 'openai') return process.env.OPENAI_API_KEY;
  if (ACTIVE === 'openrouter') return process.env.OPENROUTER_API_KEY;
  if (ACTIVE === 'groq')   return process.env.GROQ_API_KEY;
  if (ACTIVE === 'bedrock') {
    // Bedrock uses SigV4 — no Bearer token. Return a sentinel so callers
    // that do `if (!apiKey)` don't falsely detect "no credentials".
    return process.env.AWS_ACCESS_KEY_ID || 'bedrock-iam-role';
  }
  return null;
}

function chatUrl() {
  if (ACTIVE === 'vertex_gemma') return VERTEX_GEMMA_CHAT_URL;
  if (ACTIVE === 'fireworks') return FIREWORKS_CHAT_URL;
  if (ACTIVE === 'gemini')  return GEMINI_CHAT_URL;
  if (ACTIVE === 'groq')    return GROQ_CHAT_URL;
  if (ACTIVE === 'openrouter') return OPENROUTER_CHAT_URL;
  if (ACTIVE === 'bedrock') return BEDROCK_CHAT_URL_SENTINEL;
  return OPENAI_CHAT_URL;
}

function headers(extra = {}) {
  // Bedrock uses SigV4 inside the SDK — the `headers` function is for
  // raw-axios callers. When ACTIVE='bedrock' those callers should instead
  // go through `chatCompletion()` (see below).
  const base = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey() || ''}`,
  };
  if (ACTIVE === 'openrouter') {
    if (process.env.OPENROUTER_SITE_URL || process.env.APP_URL) {
      base['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || process.env.APP_URL;
    }
    base['X-OpenRouter-Title'] = process.env.OPENROUTER_APP_TITLE || 'Ari';
  }
  return { ...base, ...extra };
}

function defaultModel() { return DEFAULTS[ACTIVE].default; }
function fastModel()    { return DEFAULTS[ACTIVE].fast; }
function complexModel() { return DEFAULTS[ACTIVE].complex; }

// Cached SDK provider instances (only created once).
let _googleSdk = null;
let _openaiSdk = null;
let _openrouterSdk = null;
let _fireworksSdk = null;
let _vertexGemmaSdk = null;
let _vertexAuthClient = null;

async function getVertexAccessToken() {
  if (process.env.GOOGLE_VERTEX_ACCESS_TOKEN) return process.env.GOOGLE_VERTEX_ACCESS_TOKEN;

  if (!_vertexAuthClient) {
    const { google } = require('googleapis');
    const credentials = vertexCredentials();
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(credentials ? { credentials } : {}),
    });
    _vertexAuthClient = await auth.getClient();
  }

  const requestHeaders = await _vertexAuthClient.getRequestHeaders();
  const authorization = requestHeaders.Authorization || requestHeaders.authorization;
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Error('Vertex Gemma requires GOOGLE_VERTEX_ACCESS_TOKEN or Google Application Default Credentials.');
  }
  return token;
}

async function vertexGemmaFetch(input, init = {}) {
  const token = await getVertexAccessToken();
  const requestHeaders = new Headers(init.headers || {});
  requestHeaders.set('Authorization', `Bearer ${token}`);
  if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  return fetch(input, { ...init, headers: requestHeaders });
}

function googleSdkProvider() {
  if (!_googleSdk) {
    _googleSdk = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY
    });
  }
  return _googleSdk;
}

function openaiSdkProvider() {
  if (!_openaiSdk) {
    _openaiSdk = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiSdk;
}

function openrouterSdkProvider() {
  if (!_openrouterSdk) {
    _openrouterSdk = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      name: 'openrouter',
      headers: {
        ...(process.env.OPENROUTER_SITE_URL || process.env.APP_URL
          ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.APP_URL }
          : {}),
        'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE || 'Ari',
      },
    });
  }
  return _openrouterSdk;
}

function fireworksSdkProvider() {
  if (!_fireworksSdk) {
    _fireworksSdk = createOpenAI({
      apiKey: process.env.FIREWORKS_API_KEY,
      baseURL: (process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/+$/, '')
    });
  }
  return _fireworksSdk;
}

function vertexGemmaSdkProvider() {
  if (!_vertexGemmaSdk) {
    _vertexGemmaSdk = createOpenAI({
      apiKey: 'vertex-adc',
      baseURL: VERTEX_GEMMA_OPENAI_BASE_URL,
      name: 'vertex-gemma',
      fetch: vertexGemmaFetch
    });
  }
  return _vertexGemmaSdk;
}

/**
 * Return a Vercel-AI-SDK model instance for the given slot.
 * @param {'default'|'fast'|'complex'} [slot='default']
 * @returns the SDK model instance to pass to generateObject / generateText
 */
function sdkModel(slot = 'default') {
  const modelName = (slot === 'fast') ? fastModel()
                  : (slot === 'complex') ? complexModel()
                  : defaultModel();

  if (ACTIVE === 'vertex_gemma') return vertexGemmaSdkProvider().chat(vertexOpenApiModelName(modelName));
  if (ACTIVE === 'gemini') return googleSdkProvider()(modelName);
  if (ACTIVE === 'fireworks') return fireworksSdkProvider().chat(modelName);
  if (ACTIVE === 'openrouter') return openrouterSdkProvider().chat(modelName);
  // For OpenAI: use module-level `openai` (reads OPENAI_API_KEY directly).
  if (ACTIVE === 'openai') return openai(modelName);
  // Groq has no Vercel SDK provider — fall through to OpenAI SDK against
  // Groq's OpenAI-compat endpoint.
  if (ACTIVE === 'groq') {
    const groqClient = createOpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1'
    });
    return groqClient.chat(modelName);
  }
  return openai(modelName);
}

/**
 * Which provider is actually active (after fallback resolution).
 * Useful for logging and for call sites that need to tweak request
 * body per-provider (e.g. Gemini rejects some parameters).
 */
function providerName() { return ACTIVE; }

/**
 * Shortcut: sane request-body extras for the active provider.
 * Gemini's OpenAI-compat layer supports `response_format: { type: 'json_object' }`
 * and all three providers do — safe to always include.
 */
function supportsResponseFormat() { return true; } // all three do

/**
 * Provider-specific request-body defaults to merge into every chat completion.
 *
 * Gemini 3 Flash is a *thinking model*: by default it spends a chunk of the
 * token budget on internal reasoning before replying. Without a low
 * reasoning_effort, calls with small max_tokens (like 30 for a one-liner)
 * come back with empty content — all budget consumed by thinking.
 *
 * For Ari's workload (intent classification, conversational chat,
 * reminder parsing, language detection, summarisation) we don't need deep
 * reasoning — 'minimal' is the right default. Callers who DO want more
 * reasoning (agent-loop, complex planning) pass an override via `slot`.
 *
 * @param {'default'|'agent'|'complex'} [slot='default']
 * @returns {object}  Object to spread into the chat completions request body.
 */
/**
 * How much thinking the agent loop should buy, per model.
 *
 * Measured on gemini-3-flash-preview over 18 compound requests: a PARTIAL
 * budget is worse than none at all — 512 completes 88.9% of multi-task
 * requests, 0 completes 94.4%, at identical latency. A reasoning pass that
 * gets truncated mid-thought appears to hurt more than skipping it. Gemini 2.5
 * keeps its 512, where the budget does help.
 */
function agentThinkingBudget(model = '') {
  const override = process.env.ARI_AGENT_THINKING_BUDGET;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (/^(google\/)?gemini-3-flash/i.test(String(model))) return 0;
  return 512;
}

function defaultBodyExtras(slot = 'default', forProvider = null, model = '') {
  // forProvider lets the caller force Gemini defaults even when ACTIVE !== 'gemini'.
  // Needed for the hybrid stack (LLM_PROVIDER=bedrock + explicit gemini- model
  // routing): the axios interceptor knows the URL is Gemini's, so it passes
  // forProvider='gemini' to get the right reasoning_effort regardless of ACTIVE.
  const provider = forProvider || ACTIVE;
  if (provider !== 'gemini') return {};

  // Gemini 2.5+ are *thinking models* — they spend output tokens on internal
  // reasoning before replying. Empirical test (Apr 26 2026):
  //   reasoning_effort='minimal'                     → ~18 thinking tokens
  //   extra_body.google.thinking_config.thinking_budget=0 → 0 thinking tokens
  // The Google-native param is materially better. Note: Gemini's OpenAI-compat
  // layer rejects passing BOTH (`reasoning_effort` AND `thinking_config`) with
  // INVALID_ARGUMENT — we use ONLY the extra_body form.
  //
  // Slots map to budget:
  //   'default' (intent, simple chat)          → 0    (disable thinking)
  //   'agent'   (tool-use loop, multi-step)    → 512  (light planning)
  //   'complex' (deep reasoning, escalations)  → 2048 (real thinking)
  //
  // Some models (Flash-Lite, Pro) ignore budget=0 and use a minimum — fine,
  // we still cut waste materially vs default.
  const thinkingBudget = slot === 'agent'   ? agentThinkingBudget(model)
                       : slot === 'complex' ? 2048
                       : 0;
  return {
    extra_body: {
      google: {
        thinking_config: { thinking_budget: thinkingBudget }
      }
    }
  };
}

// ──────────────────────────────────────────────────────────────────────
// Global axios interceptor
//
// Why this exists
// ---------------
// Gemini 3 Flash is a *thinking model*. Without reasoning_effort set, it
// spends the entire max_tokens budget on internal reasoning and returns
// empty content for small requests. Ari has ~35 raw-axios call sites
// across 20+ files that hit the chat completions endpoint. Rather than
// retrofit each call site to spread `...llm.defaultBodyExtras()`, we
// install an axios interceptor that auto-merges the provider-specific
// defaults into any POST that targets the active chat completions URL.
//
// Scope
// -----
// Only fires on POSTs to the configured `chatUrl()` — everything else
// (Supabase, WhatsApp webhook, internal APIs) is untouched.
//
// Caller-set fields always win (we spread defaults FIRST, then the
// caller's body), so a site that explicitly passes `reasoning_effort:
// 'medium'` keeps its choice.
// ──────────────────────────────────────────────────────────────────────
let _interceptorInstalled = false;
function installAxiosInterceptor() {
  if (_interceptorInstalled) return;
  _interceptorInstalled = true;

  axios.interceptors.request.use(async (config) => {
    if (config.method !== 'post' || !config.url) return config;

    // ━━ RC #1 fix: Bedrock-sentinel hijack ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 17+ services in this codebase do raw axios.post(llm.chatUrl(), …)
    // instead of llm.chatCompletion(). When LLM_PROVIDER=bedrock,
    // chatUrl() returns the sentinel "bedrock://converse" — axios can't
    // resolve that URL and the call fails silently with NETWORK_ERROR.
    //
    // Attaching a custom adapter here intercepts those raw calls and
    // routes them through bedrock-adapter, returning an axios-shaped
    // response. Single fix → all 17 call sites unblocked.
    if (config.url === BEDROCK_CHAT_URL_SENTINEL) {
      config.adapter = async (cfg) => {
        let body = cfg.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch (_) { body = {}; }
        }
        const bedrock = require('./bedrock-adapter.service');
        const resp = await bedrock.chatCompletion(body, {
          timeout: cfg.timeout,
          enablePromptCache: false,
        });
        return {
          data: resp.data,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: cfg,
          request: {},
        };
      };
      return config;
    }

    if (config.url === VERTEX_GEMMA_CHAT_URL || String(config.url).startsWith(`${VERTEX_GEMMA_OPENAI_BASE_URL}/`)) {
      const token = await getVertexAccessToken();
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
      config.headers['Content-Type'] = config.headers['Content-Type'] || 'application/json';
      return config;
    }

    // ONLY inject Gemini-specific defaults when hitting the Gemini URL.
    // Previously this fired on any chatUrl() match, which meant when we
    // switched the active provider, the interceptor silently stopped
    // firing — but it also meant during migration a stale axios config
    // could send `reasoning_effort` to a non-Gemini endpoint (OpenAI
    // ignored it, but Bedrock would 400 on unknown fields).
    if (config.url !== GEMINI_CHAT_URL) return config;

    // Body may be a string (rare) or object — only patch objects.
    if (!config.data || typeof config.data !== 'object') return config;
    if (Array.isArray(config.data)) return config;

    // Pick the right slot based on the model being called:
    //   - Gemini 3 Pro / 2.5 Pro are ALWAYS-THINKING models — they reject
    //     thinking_budget=0 with "This model only works in thinking mode".
    //     Use 'complex' slot (budget=2048) so they can think but capped.
    //   - Flash/Flash-Lite accept budget=0 → use 'default' slot (no thinking,
    //     fast + cheap for intent classification + simple chat).
    //
    // forProvider='gemini' forces Gemini defaults even when ACTIVE !== 'gemini'
    // (hybrid stack: LLM_PROVIDER=bedrock + per-call gemini- model routing).
    //
    // Callers that need more thinking (agent loop) already pass the param
    // explicitly and will win via spread order.
    const model = String(config.data.model || '');
    const isThinkingOnlyModel = /^gemini-3-pro/i.test(model)
                              || /^gemini-2\.5-pro/i.test(model);
    const slot = isThinkingOnlyModel ? 'complex' : 'default';
    const extras = defaultBodyExtras(slot, 'gemini', model);
    // Only set keys the caller hasn't explicitly set.
    for (const k of Object.keys(extras)) {
      if (config.data[k] === undefined) config.data[k] = extras[k];
    }
    return config;
  });
}

installAxiosInterceptor();

// ════════════════════════════════════════════════════════════════════
// TASK-BASED MODEL ROUTING (Bedrock migration — Phase 2)
// ════════════════════════════════════════════════════════════════════
//
// `modelFor(task)` returns the right model for each task type.
// Each task gets its own env flag so we can roll out incrementally.
// When the flag is unset or 'false', the current default model is used
// (zero behavior change). When the flag names a model, routing is active.
//
// SAFETY: this function is the ONLY path for task-aware routing. It's
// intentionally separate from `defaultModel()` / `fastModel()` to prevent
// accidental behavior changes in existing call sites.
// ════════════════════════════════════════════════════════════════════

const TASK_MODEL_ENV = {
  // Ultra-light
  language_detect:    'MODEL_LANGUAGE_DETECT',
  confirmation:       'MODEL_CONFIRMATION',
  // Workhorse
  chat:               'MODEL_CHAT',
  quick_ai:           'MODEL_QUICK_AI',    // auto-label, email categorize, translate (small prompts)
  voice_polish:       'MODEL_VOICE_POLISH',
  mem0_extract:       'MODEL_MEM0',
  reminder_parse:     'MODEL_REMINDER_PARSE',
  calendar_nlp:       'MODEL_CALENDAR_NLP',
  memory_search:      'MODEL_MEMORY_SEARCH',
  pdf_analyze:        'MODEL_PDF',
  web_search_synth:   'MODEL_WEB_SEARCH',
  news_deep_dive:     'MODEL_NEWS_DEEP_DIVE',
  news_curation:      'MODEL_NEWS_CURATION',
  nightly_profile:    'MODEL_NIGHTLY_PROFILE',
  visa_batch:         'MODEL_VISA_BATCH',
  // Quality-writing
  email_draft:        'MODEL_EMAIL_DRAFT',
  sales_email:        'MODEL_SALES_EMAIL',
  resume_parse:       'MODEL_RESUME',
  visa_app_email:     'MODEL_VISA_DRAFT',
  // Intent
  intent_primary:     'MODEL_INTENT_PRIMARY',
  intent_fallback:    'MODEL_INTENT_FALLBACK',
  // Agent
  agent_primary:      'MODEL_AGENT_PRIMARY',
  agent_escalate:     'MODEL_AGENT_ESCALATE',
  // Vision
  image_analyze:      'MODEL_IMAGE_ANALYZE',
};

/**
 * Return the model for a given task.
 * Precedence: env-var override  →  current default model (no change).
 *
 * @param {string} task  One of the keys in TASK_MODEL_ENV.
 * @param {string} [slot='default']  Fallback slot if task has no env var.
 * @returns {string} Model ID (OpenAI name, Gemini name, or Bedrock alias).
 */
function modelFor(task, slot = 'default') {
  const envVar = TASK_MODEL_ENV[task];
  if (envVar && process.env[envVar] && process.env[envVar] !== 'false') {
    return process.env[envVar];
  }
  // No override → current default behavior
  if (slot === 'fast')    return fastModel();
  if (slot === 'complex') return complexModel();
  return defaultModel();
}

function fireworksRequestBody(body, model) {
  const requestBody = { ...stripInternalMessageFields(body), model };
  if (/qwen/i.test(model) && requestBody.reasoning_effort === undefined) {
    requestBody.reasoning_effort = 'none';
  }
  return requestBody;
}

/**
 * Remove Ari-only message metadata before calling an OpenAI-compatible HTTP
 * endpoint. Anthropic and Bedrock receive the original body so their adapters
 * can translate `_cachePoint` into native prompt-cache controls.
 */
function stripInternalMessageFields(body) {
  if (!Array.isArray(body?.messages)) return body;

  let changed = false;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return message;
    }
    const providerEntries = Object.entries(message).filter(([key]) => !key.startsWith('_'));
    if (providerEntries.length === Object.keys(message).length) return message;
    changed = true;
    return Object.fromEntries(providerEntries);
  });

  return changed ? { ...body, messages } : body;
}

function isRetryableVertexError(error) {
  const status = error?.response?.status;
  return status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
    || error?.code === 'ECONNABORTED'
    || error?.code === 'ETIMEDOUT';
}

/**
 * Stream an OpenAI-compatible chat completion, invoking onDelta for each
 * content chunk, and resolve with the SAME { data: { choices, usage } } shape
 * as the non-streaming path — call sites stay agnostic. Tool-call deltas are
 * accumulated per OpenAI streaming semantics (index-keyed, argument concat).
 */
async function streamOpenAiSse({ url, body, headers, timeout, signal, onDelta }) {
  const response = await axios.post(url, { ...body, stream: true }, {
    headers, timeout: timeout || 45000, signal, responseType: 'stream',
  });
  return new Promise((resolve, reject) => {
    const message = { role: 'assistant', content: '' };
    const toolCalls = [];
    let usage = null;
    let finishReason = null;
    let buffer = '';
    const stream = response.data;
    const fail = (error) => { try { stream.destroy(); } catch (_) {} reject(error); };
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch (_) { continue; }
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          message.content += delta.content;
          try { onDelta?.(delta.content); } catch (_) { /* UI-side only */ }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) {
            const index = Number.isInteger(toolDelta.index) ? toolDelta.index : 0;
            if (!toolCalls[index]) {
              toolCalls[index] = { id: toolDelta.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
            }
            if (toolDelta.id) toolCalls[index].id = toolDelta.id;
            if (toolDelta.function?.name) toolCalls[index].function.name += toolDelta.function.name;
            if (toolDelta.function?.arguments) toolCalls[index].function.arguments += toolDelta.function.arguments;
            // Gemini 3 returns a `thought_signature` alongside each tool call
            // and REQUIRES it echoed back on the next turn — without it the
            // follow-up request is rejected with a 400 ("missing a
            // thought_signature"). Rebuilding tool_calls from deltas dropped
            // it, so every streamed multi-round tool turn failed after the
            // first tool ran. Carry any provider extras through verbatim.
            if (toolDelta.extra_content) {
              toolCalls[index].extra_content = {
                ...(toolCalls[index].extra_content || {}),
                ...toolDelta.extra_content,
              };
            }
          }
        }
      }
    });
    stream.on('end', () => {
      const compacted = toolCalls.filter(Boolean);
      if (compacted.length > 0) message.tool_calls = compacted;
      resolve({ data: { choices: [{ message, finish_reason: finishReason }], usage } });
    });
    stream.on('error', fail);
    signal?.addEventListener?.('abort', () => fail(Object.assign(new Error('stream aborted'), { code: 'ERR_CANCELED' })), { once: true });
  });
}

async function callFireworks(body, timeout, model, signal = undefined) {
  return axios.post(FIREWORKS_CHAT_URL, fireworksRequestBody(body, model), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}` },
    timeout: timeout || 45000,
    signal,
  });
}

/**
 * Unified chat-completion entry point.
 *
 * Bedrock callers go through the adapter (SigV4 + shape translation).
 * All other providers use axios + OpenAI-compat endpoints as today.
 *
 * Both return the SAME shape: { data: { choices: [...], usage: {...} } }
 * so every existing call site (44 of them) keeps working unchanged.
 *
 * @param {object} body      OpenAI-format chat completion body
 * @param {object} [opts]    { timeout, enablePromptCache, headers, task, signal }
 * @returns {Promise<{data: object}>}
 */
async function chatCompletion(body, opts = {}) {
  // `signal` lets a Stop abort an in-flight model call instead of waiting out
  // the HTTP timeout. Providers that cannot honor it simply run to completion.
  // `onDelta(textChunk)` opts into SSE streaming on OpenAI-compatible paths;
  // the resolved value keeps the non-streaming shape either way.
  const { task, timeout, enablePromptCache, signal, onDelta } = opts;

  // Optional: resolve model via task if caller passed task but not model.
  if (task && !body.model) {
    body = { ...body, model: modelFor(task) };
  }
  if (!body.model) {
    body = { ...body, model: defaultModel() };
  }

  // Determine which provider handles this request.
  const modelStr = String(body.model || '');
  const bareModelStr = modelStr.includes('/') ? modelStr.split('/').pop() : modelStr;
  const isVertexGemmaModel = /^gemma-4/i.test(bareModelStr) || /^gemma/i.test(bareModelStr);
  const isFireworksModel = modelStr.startsWith('accounts/fireworks/')
    || (ACTIVE === 'fireworks' && isVertexGemmaModel);

  // Claude-* aliases get split routing:
  //   - If ANTHROPIC_API_KEY is set → Anthropic Direct (cheaper, no AISPL block,
  //     reliable prompt caching, no AWS Marketplace dependency)
  //   - Else → Bedrock (fallback, currently 403's on AISPL India accounts)
  // Nova/Titan/raw bedrock IDs always route to Bedrock since Anthropic doesn't
  // host them.
  //
  // "claude alias" = friendly name like `claude-haiku-4.5`, `claude-sonnet-4.6`.
  // Distinguished from raw Bedrock IDs (`global.anthropic.claude-...:0`) by the
  // absence of a `:` (version suffix) and the absence of a provider prefix
  // (`global.`, `us.`, `apac.`, `anthropic.`).
  const isClaudeAlias = /^claude-/.test(modelStr)
    && !modelStr.includes(':')
    && !modelStr.includes('anthropic.');
  // Explicit Gemini detection — must come BEFORE the bedrock catch-all so that
  // setting MODEL_INTENT_PRIMARY=gemini-2.5-flash routes correctly even when
  // LLM_PROVIDER=bedrock (Phase 2 hybrid stack: Gemini for primary, Bedrock
  // for Mistral/Nova/Ministral, Anthropic Direct for Claude fallback).
  const isGeminiModel = /^gemini-/.test(modelStr);
  // Bedrock-hosted models — covers Amazon Nova, Mistral (mistral-large-3,
  // ministral-3-*), OpenAI GPT-OSS (open-weights), Titan embeddings, and any
  // raw inference-profile IDs (us./apac./global./anthropic./amazon. prefixes).
  const isBedrockOnlyModel = /^(nova-|titan-|mistral-|ministral-|pixtral-|gpt-oss-|llama-)/.test(modelStr)
    || modelStr.includes('amazon.')
    || modelStr.includes('anthropic.')  // raw bedrock claude id like global.anthropic.claude-...
    || modelStr.includes('mistral.')
    || modelStr.includes('meta.')
    || modelStr.includes('openai.gpt-oss')
    || modelStr.startsWith('us.')
    || modelStr.startsWith('apac.')
    || modelStr.startsWith('global.');

  if (isClaudeAlias && process.env.ANTHROPIC_API_KEY) {
    const anthropic = require('./anthropic-adapter.service');
    return anthropic.chatCompletion(body, { timeout, enablePromptCache });
  }

  if (isFireworksModel && process.env.FIREWORKS_API_KEY) {
    return callFireworks(body, timeout, modelStr, signal);
  }

  // Gemini direct (hybrid stack — primary intent + chat tier as of Phase 2).
  // When LLM_PROVIDER=vertex_gemma is EXPLICIT and a Vertex project exists,
  // gemini-* routes through Vertex instead (GCP credits, enterprise controls,
  // no API-key path) — even if GEMINI_API_KEY happens to be set.
  const preferVertexForGoogleModels = ACTIVE === 'vertex_gemma' && !!vertexProjectId();
  if (isGeminiModel && process.env.GEMINI_API_KEY && !preferVertexForGoogleModels) {
    // Gemini may use implicit prefix caching, but enablePromptCache has no
    // explicit OpenAI-compatible request field on this route.
    const geminiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GEMINI_API_KEY}` };
    if (onDelta) {
      return streamOpenAiSse({
        url: GEMINI_CHAT_URL, body: stripInternalMessageFields(body),
        headers: geminiHeaders, timeout, signal, onDelta,
      });
    }
    return axios.post(GEMINI_CHAT_URL, stripInternalMessageFields(body), {
      headers: geminiHeaders,
      timeout: timeout || 45000,
      signal,
    });
  }

  if (isClaudeAlias || isBedrockOnlyModel || ACTIVE === 'bedrock') {
    const bedrock = require('./bedrock-adapter.service');
    return bedrock.chatCompletion(body, { timeout, enablePromptCache });
  }

  // Vertex path serves both Gemma MaaS and Gemini models. gemini-* lands here
  // when the provider is explicitly vertex_gemma, or as the keyless fallback
  // when no GEMINI_API_KEY exists but a Vertex project does.
  if ((ACTIVE === 'vertex_gemma' || isVertexGemmaModel || isGeminiModel) && vertexProjectId()) {
    const token = await getVertexAccessToken();
    const vertexModel = normalizeVertexGemmaModel(modelStr);
    // Declared outside the try so the preview-retirement fallback below can
    // re-issue the same request against a stable model.
    const vertexHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const vertexBody = {
      ...stripInternalMessageFields(body),
      model: vertexOpenApiModelName(vertexModel),
    };
    try {
      if (onDelta) {
        return await streamOpenAiSse({
          url: VERTEX_GEMMA_CHAT_URL, body: vertexBody,
          headers: vertexHeaders, timeout, signal, onDelta,
        });
      }
      return await axios.post(VERTEX_GEMMA_CHAT_URL, vertexBody, {
        headers: vertexHeaders,
        timeout: timeout || 45000,
        signal,
      });
    } catch (error) {
      // A user-initiated abort must surface as cancellation, never trigger the
      // capacity fallback (which would keep burning a stopped run's budget).
      if (signal?.aborted) throw error;

      // Preview models get retired without notice, and the symptom is a 404 on
      // every request — the agent would be hard down until someone edited .env.
      // Retry once on the stable model instead, loudly.
      const isPreview = /-preview\b/i.test(vertexModel);
      if (isPreview && error.response?.status === 404) {
        const stable = process.env.GEMINI_STABLE_FALLBACK_MODEL || 'gemini-2.5-flash';
        logger.error(`[LLM] Preview model ${vertexModel} returned 404 (likely retired); falling back to ${stable}. Pin a stable model in .env.`);
        return await axios.post(VERTEX_GEMMA_CHAT_URL, {
          ...vertexBody,
          model: vertexOpenApiModelName(stable),
        }, { headers: vertexHeaders, timeout: timeout || 45000, signal });
      }

      const fallbackEnabled = process.env.FIREWORKS_FALLBACK_ENABLED !== 'false';
      if (!fallbackEnabled || !process.env.FIREWORKS_API_KEY || !isRetryableVertexError(error)) throw error;

      const fallbackModel = process.env.FIREWORKS_FALLBACK_MODEL || DEFAULT_FIREWORKS_FALLBACK_MODEL;
      logger.warn(`[LLM] Vertex unavailable (${error.response?.status || error.code || 'timeout'}); using Fireworks fallback ${fallbackModel}`);
      return callFireworks(body, timeout, fallbackModel, signal);
    }
  }

  // Fall through to existing axios path (unchanged behavior for openai/groq).
  if (onDelta) {
    return streamOpenAiSse({
      url: chatUrl(), body: stripInternalMessageFields(body),
      headers: headers(opts.headers || {}), timeout, signal, onDelta,
    });
  }
  return axios.post(chatUrl(), stripInternalMessageFields(body), {
    headers: headers(opts.headers || {}),
    timeout: timeout || 45000,
    signal,
  });
}

module.exports = {
  providerName,
  apiKey,
  chatUrl,
  headers,
  defaultModel,
  fastModel,
  complexModel,
  sdkModel,
  supportsResponseFormat,
  defaultBodyExtras,
  agentThinkingBudget,
  installAxiosInterceptor,
  // Bedrock migration additions:
  modelFor,
  chatCompletion,
  TASK_MODEL_ENV,
  // Test hooks (pure mapping helpers — no I/O):
  _internals: { vertexOpenApiModelName, normalizeVertexGemmaModel },
};
