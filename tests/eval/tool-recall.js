#!/usr/bin/env node
'use strict';

/**
 * Tool-recall scorecard.
 *
 * Answers one question with a number: when a user phrases a request naturally,
 * does the correct tool survive lexical subsetting and reach the model?
 *
 * This is deterministic — no LLM calls, no database, no cost. It measures the
 * layer BELOW the model. A tool that never reaches the menu is uncallable, and
 * that failure is otherwise invisible: the run looks fine, the model just
 * "chose not to" use a tool it was never shown.
 *
 * Usage:
 *   node tests/eval/tool-recall.js                 # score at the default menu size
 *   node tests/eval/tool-recall.js --sweep         # score at 16/24/32/40 to size the menu
 *   node tests/eval/tool-recall.js --limit 32
 *   node tests/eval/tool-recall.js --tool manage_sales
 *   node tests/eval/tool-recall.js --json
 *
 * Exit code is 1 when recall falls under --min (default 0.90), so a phrasing
 * regression fails CI instead of reaching a user.
 */

const { CASES, EXCLUDED } = require('./tool-recall-dataset');
const { selectAriTools } = require('../../src/services/agent-tool-selector.service');
const { getToolDefinitions } = require('../../src/services/tool-definitions');

function parseArgs(argv) {
  const args = { sweep: false, json: false, tool: null, limit: null, min: 0.9 };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--sweep') args.sweep = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--tool') args.tool = argv[++i];
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--min') args.min = Number(argv[++i]);
  }
  return args;
}

function flatten(cases, only = null) {
  const flat = [];
  for (const entry of cases) {
    if (only && entry.tool !== only) continue;
    for (const says of entry.says) flat.push({ tool: entry.tool, says });
  }
  return flat;
}

async function score(cases, limit = null) {
  const options = limit ? { limit } : {};
  const perTool = new Map();
  const misses = [];
  for (const testCase of cases) {
    const selected = await selectAriTools(testCase.says, { recentMessages: [], ...options });
    const names = (Array.isArray(selected) ? selected : selected?.tools || [])
      .map((tool) => tool?.function?.name || tool?.name)
      .filter(Boolean);
    const hit = names.includes(testCase.tool);
    const bucket = perTool.get(testCase.tool) || { hit: 0, total: 0 };
    bucket.total += 1;
    if (hit) bucket.hit += 1;
    else misses.push({ ...testCase, offered: names });
    perTool.set(testCase.tool, bucket);
  }
  const total = cases.length;
  const hits = total - misses.length;
  return { total, hits, recall: total ? hits / total : 0, perTool, misses };
}

function printReport(result, label) {
  const pct = (result.recall * 100).toFixed(1);
  console.log(`\n=== tool recall ${label} ===`);
  console.log(`${result.hits}/${result.total} phrasings reached the model  (${pct}%)\n`);

  const weak = [...result.perTool.entries()]
    .map(([tool, bucket]) => ({ tool, ...bucket, rate: bucket.hit / bucket.total }))
    .filter((entry) => entry.rate < 1)
    .sort((a, b) => a.rate - b.rate);

  if (weak.length === 0) {
    console.log('Every tool in the dataset is reachable from every phrasing tested.');
    return;
  }
  console.log('Tools the filter can hide:');
  for (const entry of weak) {
    console.log(`  ${(entry.rate * 100).toFixed(0).padStart(3)}%  ${entry.tool}  (${entry.hit}/${entry.total})`);
  }
  console.log('\nUnreachable phrasings:');
  for (const miss of result.misses) {
    console.log(`  want ${miss.tool}`);
    console.log(`    "${miss.says}"`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cases = flatten(CASES, args.tool);
  if (cases.length === 0) {
    console.error(`No phrasings for "${args.tool}".`);
    process.exit(1);
  }

  // Coverage is part of the score: a tool with no phrasings is not passing,
  // it is untested, and reporting 100% while ignoring it would be a lie.
  const covered = new Set(CASES.map((entry) => entry.tool));
  const uncovered = getToolDefinitions()
    .map((tool) => tool.function.name)
    .filter((name) => !covered.has(name) && !EXCLUDED[name]);

  if (args.sweep) {
    const results = [];
    for (const limit of [16, 24, 32, 40]) {
      const result = await score(cases, limit);
      results.push({ limit, ...result });
      printReport(result, `at menu size ${limit}`);
    }
    console.log('\n=== menu size vs recall ===');
    for (const entry of results) {
      console.log(`  ${String(entry.limit).padStart(2)} tools shown -> ${(entry.recall * 100).toFixed(1)}% recall`);
    }
    if (uncovered.length) console.log(`\nNOT MEASURED (${uncovered.length}): ${uncovered.join(', ')}`);
    const best = results[results.length - 1];
    process.exit(best.recall >= args.min ? 0 : 1);
  }

  const result = await score(cases, args.limit);
  if (args.json) {
    console.log(JSON.stringify({
      recall: result.recall,
      hits: result.hits,
      total: result.total,
      uncovered,
      misses: result.misses.map((miss) => ({ tool: miss.tool, says: miss.says })),
    }, null, 2));
  } else {
    printReport(result, args.limit ? `at menu size ${args.limit}` : '(default menu size)');
    if (uncovered.length) console.log(`\nNOT MEASURED (${uncovered.length}): ${uncovered.join(', ')}`);
  }
  process.exit(result.recall >= args.min ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
