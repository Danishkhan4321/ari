#!/usr/bin/env node
'use strict';

/**
 * Tool-choice A/B — does hiding tools help or hurt?
 *
 * tool-recall.js measures whether the right tool reaches the MENU. This
 * measures whether the model then PICKS it. Those are different failures and
 * only the pair answers the real question:
 *
 *   Should we keep filtering ~90 tools down to 24 at all?
 *
 * Condition A (today): the lexical subset — high risk of the right tool being
 *   absent, low risk of the model being distracted.
 * Condition B: the full catalog — recall is 100% by construction, so the only
 *   question is whether a longer menu degrades the model's judgment.
 *
 * Everything else is held identical: same model, same temperature, same system
 * prompt, same sentences. The ONLY variable is the tool list.
 *
 * Costs real Vertex calls (2 per phrasing). Usage:
 *   node -r dotenv/config tests/eval/tool-choice-ab.js [--limit N] [--concurrency 4]
 */

const { CASES } = require('./tool-recall-dataset');
const { selectAriTools } = require('../../src/services/agent-tool-selector.service');
const { getToolDefinitions } = require('../../src/services/tool-definitions');
const llm = require('../../src/services/llm-provider');
const { runtimeConfig, isConfigured } = require('../../src/services/native-agent.service');

// Deliberately minimal and identical across conditions. A rich production
// prompt would confound the comparison with its own routing hints.
const SYSTEM = [
  'You are Ari, a personal assistant. Decide which tool serves the user request.',
  'Call exactly one tool when one fits. If none fits, reply in plain text instead.',
  'Do not ask clarifying questions; make the best single choice you can.',
].join('\n');

function parseArgs(argv) {
  const args = { limit: null, concurrency: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

function flatten(limit) {
  const flat = [];
  for (const entry of CASES) {
    for (const says of entry.says) flat.push({ tool: entry.tool, says });
  }
  return limit ? flat.slice(0, limit) : flat;
}

// Vertex answers 429 under concurrency on this project's quota, and the
// provider's capacity fallback then serves the request from a DIFFERENT model
// (Fireworks qwen). Silently comparing two conditions across two models would
// produce a confident, meaningless result — so the fallback is disabled for
// the whole run and any foreign model is a hard error, not a data point.
process.env.FIREWORKS_FALLBACK_ENABLED = 'false';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function askModel(says, tools, model, attempt = 0) {
  try {
    const response = await llm.chatCompletion({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: says }],
      tools,
      tool_choice: 'auto',
      temperature: 0.1,
      max_tokens: 300,
      ...llm.defaultBodyExtras('agent'),
    }, { task: 'agent_primary', timeout: 45000, enablePromptCache: true });

    const served = String(response?.data?.model || '');
    if (served && !served.includes(model)) {
      throw new Error(`served by ${served}, expected ${model} — refusing to mix models`);
    }
    const call = response?.data?.choices?.[0]?.message?.tool_calls?.[0];
    return {
      picked: call?.function?.name || null,
      promptTokens: response?.data?.usage?.prompt_tokens || 0,
    };
  } catch (error) {
    const status = error.response?.status;
    if ((status === 429 || status === 503) && attempt < 6) {
      await sleep(Math.min(30000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
      return askModel(says, tools, model, attempt + 1);
    }
    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: error.message };
        if (process.env.AB_DEBUG) console.error(`  [err] ${error.message}`);
      }
    }
  }));
  return results;
}

async function main() {
  if (!isConfigured()) {
    console.error('Vertex is not configured. Run with -r dotenv/config and a GOOGLE_VERTEX_PROJECT.');
    process.exit(2);
  }
  const args = parseArgs(process.argv);
  const cases = flatten(args.limit);
  const model = runtimeConfig().modelId;
  const fullCatalog = getToolDefinitions();

  console.log(`model: ${model}`);
  console.log(`phrasings: ${cases.length}  (${cases.length * 2} model calls)\n`);

  const started = Date.now();
  const byName = new Map(fullCatalog.map((tool) => [tool.function.name, tool]));

  const rows = await mapWithConcurrency(cases, args.concurrency, async (testCase, index) => {
    // selectAriTools returns MCP-shaped entries ({name, description,
    // inputSchema}); the chat API wants OpenAI shape. Resolve the subset back
    // through the same catalog object B uses, so the ONLY difference between
    // the two conditions is which tools are present — not how they are encoded.
    const subset = await selectAriTools(testCase.says, { recentMessages: [] });
    const subsetNames = (Array.isArray(subset) ? subset : subset?.tools || [])
      .map((tool) => tool?.function?.name || tool?.name)
      .filter(Boolean);
    const subsetTools = subsetNames.map((name) => byName.get(name)).filter(Boolean);
    const onMenu = subsetNames.includes(testCase.tool);

    const [a, b] = await Promise.all([
      askModel(testCase.says, subsetTools, model),
      askModel(testCase.says, fullCatalog, model),
    ]);
    if ((index + 1) % 20 === 0) process.stdout.write(`  ...${index + 1}/${cases.length}\n`);
    return { ...testCase, onMenu, subsetSize: subsetTools.length, a, b };
  });

  const good = rows.filter((row) => row && !row.error);
  const failed = rows.length - good.length;

  const hitA = good.filter((row) => row.a.picked === row.tool).length;
  const hitB = good.filter((row) => row.b.picked === row.tool).length;
  const tokensA = good.reduce((sum, row) => sum + row.a.promptTokens, 0) / (good.length || 1);
  const tokensB = good.reduce((sum, row) => sum + row.b.promptTokens, 0) / (good.length || 1);

  const pct = (n) => `${((n / (good.length || 1)) * 100).toFixed(1)}%`;
  console.log(`\n=== which condition picks the right tool? (${good.length} phrasings, ${failed} errored) ===`);
  console.log(`  A  filtered menu (~${Math.round(good.reduce((s, r) => s + r.subsetSize, 0) / (good.length || 1))} tools):  ${hitA}  ${pct(hitA)}   avg ${Math.round(tokensA)} prompt tokens`);
  console.log(`  B  full catalog  (${fullCatalog.length} tools):  ${hitB}  ${pct(hitB)}   avg ${Math.round(tokensB)} prompt tokens`);

  // The decisive slice: phrasings where the filter HID the right tool. If B
  // rescues them, the filter is costing real capability.
  const hidden = good.filter((row) => !row.onMenu);
  const rescued = hidden.filter((row) => row.b.picked === row.tool);
  console.log(`\n  of ${hidden.length} phrasings where the filter hid the right tool, the full catalog recovered ${rescued.length}`);

  // The counter-risk: phrasings the filter got right but a longer menu confuses.
  const regressed = good.filter((row) => row.a.picked === row.tool && row.b.picked !== row.tool);
  console.log(`  of ${hitA} the filtered menu got right, the full catalog broke ${regressed.length}`);
  if (regressed.length) {
    console.log('\n  distracted by the bigger menu:');
    for (const row of regressed.slice(0, 15)) {
      console.log(`    "${row.says}"\n      want ${row.tool}, full catalog chose ${row.b.picked || 'no tool'}`);
    }
  }

  console.log(`\n  elapsed ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(`  extra prompt tokens per turn if we drop the filter: ~${Math.round(tokensB - tokensA)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
