#!/usr/bin/env node
'use strict';

/**
 * Compound-request bench — can the model do BOTH things?
 *
 * The single-prompt scorecard (model-bench.js) asks "did it pick the right
 * tool". This asks the harder question: given a request with two or three
 * tasks in it, does the model emit a tool call for every one, or does it
 * confidently answer having silently dropped the tail?
 *
 * Scoring is set-based and order-independent:
 *   complete  — every required tool was called (the only outcome a user reads
 *               as "it worked")
 *   recall    — fraction of required tools called, so a model that gets 2 of 3
 *               is distinguished from one that gets 1 of 3
 *   calls     — how many tool calls it emitted at all; a model averaging 1.0
 *               on two-task requests isn't multi-tasking, it's guessing
 *
 * The FULL tool catalog is used here, not the lexical subset. A compound
 * request spans two domains, and we already measured that the subset hides the
 * right tool ~1 time in 5 for a SINGLE domain — running compounds through it
 * would measure the filter, not the model.
 */

const { COMPOUND_CASES } = require('./compound-dataset');
const { getToolDefinitions } = require('../../src/services/tool-definitions');
const llm = require('../../src/services/llm-provider');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

process.env.FIREWORKS_FALLBACK_ENABLED = 'false';

const SYSTEM = [
  'You are Ari, a personal assistant.',
  'The user may ask for several things in one message. Call a tool for EVERY',
  'task they ask for — do not stop after the first one. Use parallel tool calls.',
  'Do not ask clarifying questions; make the best choice you can.',
].join('\n');

let _token = null;
async function vertexToken() {
  if (_token) return _token;
  const raw = process.env.GOOGLE_VERTEX_CREDENTIALS || '';
  const credentials = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], credentials });
  _token = (await (await auth.getClient()).getAccessToken()).token;
  return _token;
}

async function callModel(body, options) {
  if (!String(body.model).includes('/')) return llm.chatCompletion(body, options);
  const token = await vertexToken();
  const url = `https://aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_VERTEX_PROJECT}`
    + '/locations/global/endpoints/openapi/chat/completions';
  return axios.post(url, body, { headers: { Authorization: `Bearer ${token}` }, timeout: options.timeout || 60000 });
}

function parseArgs(argv) {
  const args = { models: [], maxTokens: 2000, retries: 2, extra: {} };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--models') args.models = argv[++i].split(',').map((m) => m.trim());
    else if (argv[i] === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (argv[i] === '--extra') args.extra = JSON.parse(argv[++i]);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(model, testCase, tools, maxTokens, extra, attempt = 0) {
  try {
    const started = Date.now();
    const response = await callModel({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: testCase.says }],
      tools,
      tool_choice: 'auto',
      max_tokens: maxTokens,
      ...extra,
    }, { task: 'agent_primary', timeout: 60000, enablePromptCache: false });

    const calls = (response?.data?.choices?.[0]?.message?.tool_calls || [])
      .map((c) => c.function?.name).filter(Boolean);
    const got = new Set(calls);
    const hit = testCase.tools.filter((t) => got.has(t));
    return {
      ms: Date.now() - started,
      calls,
      recall: hit.length / testCase.tools.length,
      complete: hit.length === testCase.tools.length,
      missed: testCase.tools.filter((t) => !got.has(t)),
    };
  } catch (e) {
    // 429 is this project's chronic quota ceiling, not a model failure — back
    // off and retry rather than scoring it as a miss.
    const status = e.response?.status;
    if ((status === 429 || status === 503) && attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      return runCase(model, testCase, tools, maxTokens, extra, attempt + 1);
    }
    return { error: `HTTP ${status || ''} ${(e.message || '').slice(0, 60)}` };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const tools = getToolDefinitions();
  console.log(`compound cases: ${COMPOUND_CASES.length}   tools offered: ${tools.length} (full catalog)\n`);

  const summaries = [];
  for (const model of args.models) {
    const rows = [];
    for (const testCase of COMPOUND_CASES) {
      rows.push({ ...testCase, ...(await runCase(model, testCase, tools, args.maxTokens, args.extra)) });
      process.stdout.write(`\r  ${model}: ${rows.length}/${COMPOUND_CASES.length}   `);
    }
    const ok = rows.filter((r) => !r.error);
    const complete = ok.filter((r) => r.complete).length;
    const recall = ok.reduce((s, r) => s + r.recall, 0) / (ok.length || 1);
    const avgCalls = ok.reduce((s, r) => s + r.calls.length, 0) / (ok.length || 1);
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    summaries.push({
      model,
      n: ok.length,
      errors: rows.length - ok.length,
      complete: ok.length ? complete / ok.length : 0,
      recall,
      avgCalls,
      p50: lat[Math.floor(lat.length / 2)] || 0,
      rows,
    });
    process.stdout.write('\n');
  }

  console.log('\n=== compound (multi-task) bench ===');
  console.log('model                              n   ALL tasks   tool recall   avg calls   p50');
  for (const s of summaries) {
    console.log(
      `${s.model.padEnd(34)} ${String(s.n).padStart(2)}   ${(s.complete * 100).toFixed(1).padStart(6)}%   `
      + `${(s.recall * 100).toFixed(1).padStart(8)}%   ${s.avgCalls.toFixed(2).padStart(6)}   ${String(s.p50).padStart(5)}ms`
      + (s.errors ? `   (${s.errors} errored)` : ''),
    );
  }

  for (const s of summaries) {
    const dropped = s.rows.filter((r) => !r.error && !r.complete);
    if (!dropped.length) continue;
    console.log(`\n  ${s.model} — tasks it dropped:`);
    for (const d of dropped.slice(0, 6)) {
      console.log(`    "${d.says.slice(0, 62)}${d.says.length > 62 ? '…' : ''}"`);
      console.log(`       missed: ${d.missed.join(', ')}   (called: ${d.calls.join(', ') || 'nothing'})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
