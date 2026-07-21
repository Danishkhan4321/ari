/**
 * Model usage tracker — records every routed LLM call for cost + leakage audit.
 *
 * Two purposes:
 *   1. COST monitoring — detect runaway spend per model
 *   2. LEAKAGE audit — catch cases where an expensive model (Sonnet) is being
 *      called for a cheap task (like language detection) by mistake.
 *
 * Every wired call site calls `log({ task, model, usage })` after a successful
 * LLM invocation. Data is accumulated in-memory (BoundedMap) and periodically
 * flushed to disk as JSONL so you can inspect after a run.
 *
 * Env:
 *   MODEL_USAGE_TRACKING_ENABLED = 'true' (default) / 'false'
 *   MODEL_USAGE_LOG_PATH         = path (default: logs/model-usage.jsonl)
 *   MODEL_USAGE_COST_CAP_DAILY   = USD (default: 50.00) — warn above this
 *
 * Pricing table (April 2026, Bedrock on-demand) so we can compute USD per call:
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ENABLED = process.env.MODEL_USAGE_TRACKING_ENABLED !== 'false';
const LOG_PATH = process.env.MODEL_USAGE_LOG_PATH || path.join(process.cwd(), 'logs', 'model-usage.jsonl');
const DAILY_CAP_USD = Number(process.env.MODEL_USAGE_COST_CAP_DAILY) || 50;

// Ensure log dir exists
try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch (_) {}

// $/1M tokens — pinned to Bedrock on-demand rates April 2026
const PRICING = {
  // Claude (cache-read discount not applied here; we read actual cacheReadInputTokens from usage)
  'claude-haiku-4.5':  { in: 1.00, out: 5.00, cached_in: 0.10 },
  'claude-sonnet-4.6': { in: 3.00, out: 15.00, cached_in: 0.30 },
  'claude-opus-4.6':   { in: 5.00, out: 25.00, cached_in: 0.50 },
  // Amazon Nova (no prompt caching yet via converse for most use)
  'nova-micro':        { in: 0.035, out: 0.14 },
  'nova-lite':         { in: 0.06,  out: 0.24 },
  'nova-pro':          { in: 0.80,  out: 3.20 },
  'nova-premier':      { in: 2.50,  out: 12.50 },
  // Vertex AI MaaS Gemma 4 pricing used for the demo default path.
  'gemma-4-26b-a4b-it': { in: 0.15,  out: 0.60, cached_in: 0.015 },
  'gemma-4-31b-it':     { in: 0.15,  out: 0.60, cached_in: 0.015 },
  'qwen3p7-plus':        { in: 0.50,  out: 3.00, cached_in: 0.10 },
  // Titan embeddings
  'titan-embed':       { in: 0.02,  out: 0 },
  // Fallback so unknown models don't break tracking
  'unknown':           { in: 0,     out: 0 },
};

// Task → expected model map (for leakage detection)
// If a call fires for `task=X` with a model NOT in this list, flag leak.
const EXPECTED_MODELS = {
  language_detect:   ['nova-micro', 'gemini-3-flash-preview'],
  confirmation:      ['nova-micro', 'gemini-3-flash-preview'],
  intent_primary:    ['claude-haiku-4.5', 'nova-lite', 'nova-pro', 'gemini-3-flash-preview'],
  intent_fallback:   ['claude-haiku-4.5', 'claude-sonnet-4.6', 'nova-lite'],
  chat:              ['nova-pro', 'nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  mem0_extract:      ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  reminder_parse:    ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  calendar_nlp:      ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  memory_search:     ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  pdf_analyze:       ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  web_search_synth:  ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  news_deep_dive:    ['nova-lite', 'gemini-3-flash-preview', 'gpt-4.1-mini'],
  image_analyze:     ['claude-haiku-4.5', 'nova-lite', 'nova-pro', 'gemini-3-flash-preview'],
  email_draft:       ['claude-sonnet-4.6', 'gemini-3-flash-preview'],
  sales_email:       ['claude-sonnet-4.6', 'gemini-3-flash-preview'],
  resume_parse:      ['claude-sonnet-4.6', 'gemini-3-flash-preview'],
  visa_app_email:    ['claude-sonnet-4.6', 'gemini-3-flash-preview'],
  visa_batch:        ['nova-pro', 'nova-lite', 'gemini-3-flash-preview'],
  agent_primary:     ['claude-haiku-4.5', 'gemini-3-flash-preview'],
  agent_escalate:    ['claude-sonnet-4.6', 'gemini-3-flash-preview'],
  nightly_profile:   ['nova-lite', 'gemini-3-flash-preview'],
  news_curation:     ['nova-pro', 'nova-lite', 'gemini-3-flash-preview'],
};

const CONFIGURED_TASK_MODEL_ENV = {
  language_detect: 'MODEL_LANGUAGE_DETECT',
  confirmation: 'MODEL_CONFIRMATION',
  intent_primary: 'MODEL_INTENT_PRIMARY',
  intent_fallback: 'MODEL_INTENT_FALLBACK',
  chat: 'MODEL_CHAT',
  mem0_extract: 'MODEL_MEM0',
  reminder_parse: 'MODEL_REMINDER_PARSE',
  calendar_nlp: 'MODEL_CALENDAR_NLP',
  memory_search: 'MODEL_MEMORY_SEARCH',
  pdf_analyze: 'MODEL_PDF',
  web_search_synth: 'MODEL_WEB_SEARCH',
  news_deep_dive: 'MODEL_NEWS_DEEP_DIVE',
  image_analyze: 'MODEL_IMAGE_ANALYZE',
  email_draft: 'MODEL_EMAIL_DRAFT',
  sales_email: 'MODEL_SALES_EMAIL',
  agent_primary: 'MODEL_AGENT_PRIMARY',
  agent_escalate: 'MODEL_AGENT_ESCALATE',
};

// Running totals (in-memory, since last restart)
const _totals = {
  byModel: {},        // { 'claude-haiku-4.5': { calls, inTok, outTok, usd } }
  byTask:  {},        // { 'intent_primary':  { calls, usd } }
  today:   { date: todayDateStr(), usd: 0 },
  leakages: [],       // [{ task, model, ts }]
};

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function rollDayIfNeeded() {
  const today = todayDateStr();
  if (_totals.today.date !== today) {
    _totals.today = { date: today, usd: 0 };
  }
}

/**
 * Compute USD cost for a given call's usage payload.
 * usage = { prompt_tokens, completion_tokens, cache_read_input_tokens? }
 */
function costFor(modelAlias, usage) {
  const p = PRICING[modelAlias] || PRICING.unknown;
  // Bedrock reports prompt_tokens INCLUSIVE of cache_read AND cache_creation
  // tokens for Anthropic. Subtract both so we don't double-count.
  const cachedReadTok = usage?.cache_read_input_tokens || 0;
  const cachedWriteTok = usage?.cache_creation_input_tokens || 0;
  const inTok = (usage?.prompt_tokens || 0) - cachedReadTok - cachedWriteTok;
  const outTok = usage?.completion_tokens || 0;
  // Anthropic pricing (5-min ephemeral cache):
  //   cache_read    ≈ 10% of input price
  //   cache_creation ≈ 125% of input price (one-time premium per 5-min window)
  return (
    (inTok * p.in) / 1_000_000 +
    (cachedReadTok * (p.cached_in || p.in)) / 1_000_000 +
    (cachedWriteTok * (p.in * 1.25)) / 1_000_000 +
    (outTok * p.out) / 1_000_000
  );
}

/**
 * Normalize a full Bedrock model ID or short alias to our pricing key.
 *   'us.anthropic.claude-haiku-4-5-20251001-v1:0' → 'claude-haiku-4.5'
 *   'us.amazon.nova-lite-v1:0'                    → 'nova-lite'
 *   'claude-haiku-4.5'                            → 'claude-haiku-4.5'
 */
function normalizeModelKey(model) {
  if (!model) return 'unknown';
  const s = String(model);
  if (s.includes('claude-haiku-4-5') || s === 'claude-haiku-4.5') return 'claude-haiku-4.5';
  if (s.includes('claude-sonnet-4-6') || s === 'claude-sonnet-4.6') return 'claude-sonnet-4.6';
  if (s.includes('claude-opus-4-6') || s === 'claude-opus-4.6') return 'claude-opus-4.6';
  if (s.includes('nova-micro') || s === 'nova-micro') return 'nova-micro';
  if (s.includes('nova-lite') || s === 'nova-lite') return 'nova-lite';
  if (s.includes('nova-pro') || s === 'nova-pro') return 'nova-pro';
  if (s.includes('nova-premier') || s === 'nova-premier') return 'nova-premier';
  if (s.includes('titan-embed') || s === 'titan-embed') return 'titan-embed';
  if (s.includes('gemma-4-31b')) return 'gemma-4-31b-it';
  if (s.includes('gemma-4-26b')) return 'gemma-4-26b-a4b-it';
  if (s.includes('qwen3p7-plus')) return 'qwen3p7-plus';
  if (s.includes('gemini')) return 'gemini-3-flash-preview';
  if (s.includes('gpt-4.1-mini') || s === 'gpt-4.1-mini') return 'gpt-4.1-mini';
  if (s.includes('gpt-4.1')) return 'gpt-4.1';
  if (s.includes('gpt-4.1-nano')) return 'gpt-4.1-nano';
  return s;
}

function isExpectedModel(task, model) {
  const modelKey = normalizeModelKey(model);
  const configuredEnv = CONFIGURED_TASK_MODEL_ENV[task];
  const configuredModel = configuredEnv ? process.env[configuredEnv] : null;
  if (configuredModel && normalizeModelKey(configuredModel) === modelKey) return true;

  const expected = EXPECTED_MODELS[task];
  if (!expected) return true;
  if (modelKey.startsWith('gemma-4-')) return true;
  return expected.includes(modelKey) || expected.some(candidate => modelKey.includes(candidate));
}

/**
 * Main entry — called after every routed LLM call.
 */
function log({ task, model, usage, userPhone, latencyMs }) {
  if (!ENABLED) return;
  try {
    rollDayIfNeeded();

    const modelKey = normalizeModelKey(model);
    const usd = costFor(modelKey, usage || {});

    // Accumulate
    const m = _totals.byModel[modelKey] || { calls: 0, inTok: 0, outTok: 0, cachedTok: 0, cacheWriteTok: 0, usd: 0 };
    m.calls += 1;
    m.inTok += (usage?.prompt_tokens || 0);
    m.cachedTok += (usage?.cache_read_input_tokens || 0);
    m.cacheWriteTok += (usage?.cache_creation_input_tokens || 0);
    m.outTok += (usage?.completion_tokens || 0);
    m.usd += usd;
    _totals.byModel[modelKey] = m;

    const t = _totals.byTask[task] || { calls: 0, usd: 0, models: {} };
    t.calls += 1;
    t.usd += usd;
    t.models[modelKey] = (t.models[modelKey] || 0) + 1;
    _totals.byTask[task] = t;

    _totals.today.usd += usd;

    // Leakage detection
    const expected = EXPECTED_MODELS[task];
    const isLeakage = !isExpectedModel(task, modelKey);
    if (isLeakage) {
      _totals.leakages.push({ task, model: modelKey, ts: new Date().toISOString() });
      logger.warn({ event: 'model_leakage', task, actual: modelKey, expected }, `[usage] LEAKAGE: task=${task} used ${modelKey} (expected one of: ${expected.join(', ')})`);
    }

    // Cost cap warning
    if (_totals.today.usd > DAILY_CAP_USD) {
      logger.warn({ event: 'cost_cap', today_usd: _totals.today.usd.toFixed(4), cap: DAILY_CAP_USD }, `[usage] DAILY COST CAP EXCEEDED: $${_totals.today.usd.toFixed(2)}`);
    }

    // Append-only JSONL log
    const entry = {
      ts: new Date().toISOString(),
      task,
      model: modelKey,
      usd: Number(usd.toFixed(6)),
      tokens: {
        in: usage?.prompt_tokens || 0,
        cached: usage?.cache_read_input_tokens || 0,
        cache_write: usage?.cache_creation_input_tokens || 0,
        out: usage?.completion_tokens || 0,
      },
      latency_ms: latencyMs,
      user_phone_tail: userPhone ? String(userPhone).slice(-4) : null,
      leakage: isLeakage || false,
    };
    fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', () => {});
  } catch (e) {
    logger.warn(`[usage tracker] log failed: ${e.message}`);
  }
}

/**
 * Return a snapshot of totals for debugging / admin endpoint.
 */
function snapshot() {
  rollDayIfNeeded();
  return {
    date: _totals.today.date,
    today_usd: Number(_totals.today.usd.toFixed(4)),
    by_model: _totals.byModel,
    by_task:  _totals.byTask,
    leakages: _totals.leakages.slice(-20),
  };
}

/**
 * Reset counters (for testing).
 */
function reset() {
  _totals.byModel = {};
  _totals.byTask = {};
  _totals.today = { date: todayDateStr(), usd: 0 };
  _totals.leakages = [];
}

module.exports = {
  log,
  snapshot,
  reset,
  costFor,
  isExpectedModel,
  normalizeModelKey,
  EXPECTED_MODELS,
  PRICING,
};
