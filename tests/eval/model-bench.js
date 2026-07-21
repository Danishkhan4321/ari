#!/usr/bin/env node
'use strict';

/**
 * Model bench — accuracy, cost, and latency for the SAME agent workload.
 *
 * Runs the tool-recall phrasings against several models under production
 * conditions (the 24-tool lexical subset the agent actually ships), and
 * reports the three numbers that decide a model choice together: does it pick
 * the right tool, what does the turn cost, how long does it take.
 *
 * SPEND IS CAPPED. Anthropic credit is prepaid and small, so the run tracks
 * cost per call from each response's own usage numbers and aborts the moment
 * the cap would be exceeded — a mis-estimate stops the run instead of the
 * card. Partial results are still reported.
 *
 * Usage:
 *   node -r dotenv/config tests/eval/model-bench.js --models claude-haiku-4.5,claude-sonnet-5 --limit 15 --budget 0.30
 *   node -r dotenv/config tests/eval/model-bench.js --models gemini-2.5-flash --limit 30 --budget 0
 */

const { CASES } = require('./tool-recall-dataset');
const { selectAriTools } = require('../../src/services/agent-tool-selector.service');
const { getToolDefinitions } = require('../../src/services/tool-definitions');
const llm = require('../../src/services/llm-provider');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// Publisher-prefixed Vertex MaaS models (qwen/..., meta/..., deepseek-ai/...)
// don't go through llm-provider's routing, which only knows Gemini and Claude.
// Call the OpenAI-compat endpoint directly so they can be compared on exactly
// the same request shape as everything else.
let _vertexToken = null;
async function vertexToken() {
  if (_vertexToken) return _vertexToken;
  const raw = process.env.GOOGLE_VERTEX_CREDENTIALS || '';
  const credentials = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], credentials });
  _vertexToken = (await (await auth.getClient()).getAccessToken()).token;
  return _vertexToken;
}

async function callModel(body, options) {
  if (!String(body.model).includes('/')) return llm.chatCompletion(body, options);
  const token = await vertexToken();
  const project = process.env.GOOGLE_VERTEX_PROJECT;
  const url = `https://aiplatform.googleapis.com/v1/projects/${project}`
    + '/locations/global/endpoints/openapi/chat/completions';
  return axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: options.timeout || 45000,
  });
}

// Never silently serve one model's traffic from another — that would make the
// whole comparison meaningless (see tool-choice-ab.js for how this bit us).
process.env.FIREWORKS_FALLBACK_ENABLED = 'false';

const SYSTEM = [
  'You are Ari, a personal assistant. Decide which tool serves the user request.',
  'Call exactly one tool when one fits. If none fits, reply in plain text instead.',
  'Do not ask clarifying questions; make the best single choice you can.',
].join('\n');

// USD per million tokens. Anthropic list prices; Sonnet 5 is at intro pricing
// through 2026-08-31. Gemini is approximate — treat its cost column as
// indicative, not billing-grade.
const PRICING = {
  'claude-haiku-4.5': { in: 1.00, out: 5.00, exact: true },
  'claude-sonnet-5': { in: 2.00, out: 10.00, exact: true },
  'claude-sonnet-4.6': { in: 3.00, out: 15.00, exact: true },
  'claude-opus-4-8': { in: 5.00, out: 25.00, exact: true },
  'gemini-2.5-flash': { in: 0.30, out: 2.50, exact: false },
  'gemini-2.5-pro': { in: 1.25, out: 10.00, exact: false },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, exact: false },
  // Preview pricing is not published in a form worth quoting — cost column
  // for this model is a placeholder, not a bill.
  'gemini-3.1-pro-preview': { in: 0, out: 0, exact: false },
};

function priceFor(model) {
  return PRICING[model] || { in: 0, out: 0, exact: false };
}

// Anthropic reports input_tokens as the UNCACHED REMAINDER only — the cached
// span is billed separately at 1.25x (write) or 0.1x (read). Pricing off
// prompt_tokens alone undercounts by ~30x on a tool-heavy request.
function costOf(model, usage) {
  const p = priceFor(model);
  const inTok = usage.prompt_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = (usage.completion_tokens || 0) + (usage.completion_tokens_details?.reasoning_tokens || 0);
  return ((inTok + write * 1.25 + read * 0.1) / 1e6) * p.in + (out / 1e6) * p.out;
}

function parseArgs(argv) {
  const args = { models: ['claude-haiku-4.5'], limit: 15, budget: 0.5, concurrency: 1, maxTokens: 300, extra: {}, full: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--models') args.models = argv[++i].split(',').map((m) => m.trim());
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--budget') args.budget = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (argv[i] === '--extra') args.extra = JSON.parse(argv[++i]);
    else if (argv[i] === '--full') args.full = true;
  }
  return args;
}

function phrasings(limit) {
  const flat = [];
  for (const entry of CASES) for (const says of entry.says) flat.push({ tool: entry.tool, says });
  if (!limit || limit >= flat.length) return flat;
  // Evenly spaced rather than the first N, so a small pilot still spans every
  // domain instead of over-sampling reminders and calendar.
  const step = flat.length / limit;
  return Array.from({ length: limit }, (_, i) => flat[Math.floor(i * step)]);
}

class BudgetExceeded extends Error {}

async function benchModel(model, cases, catalogByName, budget, maxTokens, extra, full) {
  const rows = [];
  let spent = 0;
  let truncated = 0;

  for (const testCase of cases) {
    const subset = await selectAriTools(testCase.says, { recentMessages: [] });
    const names = (Array.isArray(subset) ? subset : subset?.tools || [])
      .map((tool) => tool?.function?.name || tool?.name)
      .filter(Boolean);
    const tools = full ? [...catalogByName.values()] : names.map((name) => catalogByName.get(name)).filter(Boolean);

    // Stop BEFORE the call that would breach the cap, using this model's worst
    // observed cost so far as the estimate.
    const worstSoFar = rows.length ? Math.max(...rows.map((r) => r.cost)) : 0;
    if (budget > 0 && spent + worstSoFar * 1.5 > budget) {
      throw Object.assign(new BudgetExceeded('budget cap reached'), { rows, spent });
    }

    const started = Date.now();
    let picked = null;
    let usage = {};
    let error = null;
    try {
      const response = await callModel({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: testCase.says }],
        tools,
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens: maxTokens,
        ...extra,
        // Caching is OFF for the bench: the tool subset varies per turn so the
        // cache can never hit, and leaving it on would add a 1.25x write
        // premium to every call for no benefit.
      }, { task: 'agent_primary', timeout: 45000, enablePromptCache: false });

      const message = response?.data?.choices?.[0]?.message;
      picked = message?.tool_calls?.[0]?.function?.name || null;
      if (response?.data?.choices?.[0]?.finish_reason === 'length') truncated += 1;
      usage = response?.data?.usage || {};
    } catch (e) {
      const detail = e.response?.data?.error?.message || e.response?.data?.[0]?.error?.message || e.message || '';
      error = (e.response?.status ? `HTTP ${e.response.status}: ` : '') + String(detail).split('\n')[0].slice(0, 90);
    }

    const cost = costOf(model, usage);
    const promptTokens = (usage.prompt_tokens||0)+(usage.cache_creation_input_tokens||0)+(usage.cache_read_input_tokens||0);
    const completionTokens = (usage.completion_tokens||0)+(usage.completion_tokens_details?.reasoning_tokens||0);
    spent += cost;
    rows.push({
      ...testCase,
      picked,
      correct: picked === testCase.tool,
      ms: Date.now() - started,
      promptTokens,
      completionTokens,
      cost,
      error,
    });
    process.stdout.write(`\r  ${model}: ${rows.length}/${cases.length}  $${spent.toFixed(4)}   `);
  }
  if (truncated) console.log(`
  NOTE: ${truncated}/${rows.length} ${model} calls hit max_tokens — raise --max-tokens`);
  return { rows, spent };
}

function summarize(model, rows, spent) {
  const ok = rows.filter((r) => !r.error);
  const correct = ok.filter((r) => r.correct).length;
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => latencies[Math.floor(latencies.length * q)] || 0;
  const avgIn = Math.round(ok.reduce((s, r) => s + r.promptTokens, 0) / (ok.length || 1));
  const avgOut = Math.round(ok.reduce((s, r) => s + r.completionTokens, 0) / (ok.length || 1));
  return {
    model,
    n: ok.length,
    errors: rows.length - ok.length,
    accuracy: ok.length ? correct / ok.length : 0,
    p50: p(0.5),
    p90: p(0.9),
    avgMs: Math.round(ok.reduce((s, r) => s + r.ms, 0) / (ok.length || 1)),
    avgIn,
    avgOut,
    spent,
    costPerCall: ok.length ? spent / ok.length : 0,
    errorSamples: Object.entries(rows.filter(r=>r.error).reduce((acc,r)=>{acc[r.error]=(acc[r.error]||0)+1;return acc;},{})).sort((a,b)=>b[1]-a[1]).slice(0,4),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const cases = phrasings(args.limit);
  const catalogByName = new Map(getToolDefinitions().map((t) => [t.function.name, t]));

  console.log(`phrasings: ${cases.length} per model`);
  console.log(`models:    ${args.models.join(', ')}`);
  console.log(`budget:    ${args.budget > 0 ? `$${args.budget.toFixed(2)} (hard cap, aborts mid-run)` : 'uncapped'}\n`);

  const summaries = [];
  let totalSpent = 0;

  for (const model of args.models) {
    const remaining = args.budget > 0 ? args.budget - totalSpent : 0;
    if (args.budget > 0 && remaining <= 0) {
      console.log(`\n  ${model}: SKIPPED — budget exhausted`);
      continue;
    }
    try {
      const { rows, spent } = await benchModel(model, cases, catalogByName, remaining, args.maxTokens, args.extra, args.full);
      totalSpent += spent;
      summaries.push(summarize(model, rows, spent));
      process.stdout.write('\n');
    } catch (e) {
      if (e instanceof BudgetExceeded || e.rows) {
        totalSpent += e.spent || 0;
        summaries.push(summarize(model, e.rows || [], e.spent || 0));
        console.log(`\n  ${model}: STOPPED at the budget cap after ${(e.rows || []).length} calls`);
      } else {
        console.log(`\n  ${model}: FAILED — ${e.message}`);
      }
    }
  }

  console.log('\n=== model bench ===');
  console.log('model                 n    correct    p50      avg      in/out tok     $/call     total');
  for (const s of summaries) {
    const price = priceFor(s.model);
    console.log(
      `${s.model.padEnd(20)} ${String(s.n).padStart(3)}   ${(s.accuracy * 100).toFixed(1).padStart(5)}%   `
      + `${String(s.p50).padStart(5)}ms  ${String(s.avgMs).padStart(5)}ms  `
      + `${String(s.avgIn).padStart(6)}/${String(s.avgOut).padEnd(4)}  `
      + `$${s.costPerCall.toFixed(5)}${price.exact ? ' ' : '~'}  $${s.spent.toFixed(4)}`
      + (s.errors ? `   (${s.errors} errored)` : ''),
    );
  }
  console.log(`\ntotal spent this run: $${totalSpent.toFixed(4)}`);
  const full = summaries.filter((s) => s.n > 0).map((s) => {
    const perCall = s.costPerCall;
    return `  ${s.model}: full 180-phrase run would cost ~$${(perCall * 180).toFixed(2)}`;
  });
  if (full.length) console.log('\nextrapolated:\n' + full.join('\n'));
  console.log('\n~ = approximate pricing (not billing-grade)');
}

main().catch((e) => { console.error(e); process.exit(1); });
