'use strict';

// Guards the tool-recall scorecard (tests/eval/tool-recall.js).
//
// Recall = "when a user phrases a request naturally, does the correct tool
// survive lexical subsetting and reach the model?" A tool that misses the cut
// is uncallable, and nothing else in the suite notices: the turn succeeds, the
// model simply answers in prose because it was never shown the tool.
//
// The FLOOR here is a ratchet, not a target. It is set just under the measured
// value so a phrasing regression fails, and it should be raised whenever the
// real number improves.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CASES, EXCLUDED } = require('./eval/tool-recall-dataset');
const { selectAriTools } = require('../src/services/agent-tool-selector.service');
const { getToolDefinitions } = require('../src/services/tool-definitions');

// Measured 2026-07-21 at the default menu size: 142/175 = 81.1%.
const RECALL_FLOOR = 0.78;

async function measure() {
  const misses = [];
  let total = 0;
  for (const entry of CASES) {
    for (const says of entry.says) {
      total += 1;
      const selected = await selectAriTools(says, { recentMessages: [] });
      const names = (Array.isArray(selected) ? selected : selected?.tools || [])
        .map((tool) => tool?.function?.name || tool?.name)
        .filter(Boolean);
      if (!names.includes(entry.tool)) misses.push(`${entry.tool} <- "${says}"`);
    }
  }
  return { total, misses, recall: (total - misses.length) / total };
}

test('every tool has phrasings, so the dataset cannot rot as tools are added', () => {
  const covered = new Set(CASES.map((entry) => entry.tool));
  const missing = getToolDefinitions()
    .map((tool) => tool.function.name)
    .filter((name) => !covered.has(name) && !EXCLUDED[name]);
  assert.deepEqual(missing, [],
    `these tools have no natural-phrasing coverage: ${missing.join(', ')}. `
    + 'Add phrasings to tests/eval/tool-recall-dataset.js, or list the tool in '
    + 'EXCLUDED with the reason it is routed by conversation state instead.');
});

// A few tools are named after the only noun a user can say. "Google Tasks" is
// what distinguishes manage_google_tasks from manage_tasks — asking for a
// phrasing without "google" would be asking for an ambiguous phrasing.
const NAME_IS_UNAVOIDABLE = new Set(['manage_google_tasks']);

test('dataset phrasings avoid the tool name itself, or they prove nothing', () => {
  const cheating = [];
  for (const entry of CASES) {
    if (NAME_IS_UNAVOIDABLE.has(entry.tool)) continue;
    // "cancel_reminder" is trivially matched by the word "reminder" — a
    // phrasing built from the tool's own name tests the alias table, not the
    // user's language. At least one phrasing per tool must avoid every word
    // in the tool name. Whole words only: "overview" is not "view".
    const words = entry.tool.split('_').filter((word) => word.length > 3);
    const honest = entry.says.some((says) => !words.some(
      (word) => new RegExp(`\\b${word}`, 'i').test(says),
    ));
    if (!honest) cheating.push(entry.tool);
  }
  assert.deepEqual(cheating, [],
    `every phrasing for these tools reuses the tool's own name: ${cheating.join(', ')}`);
});

test('natural phrasing reaches the right tool at least RECALL_FLOOR of the time', async () => {
  const result = await measure();
  assert.ok(result.recall >= RECALL_FLOOR,
    `tool recall fell to ${(result.recall * 100).toFixed(1)}% (floor ${(RECALL_FLOOR * 100).toFixed(0)}%).\n`
    + `Unreachable:\n  ${result.misses.join('\n  ')}\n`
    + 'Run: node tests/eval/tool-recall.js');
});

test('the tools a user reaches for constantly are never crowded off the menu', async () => {
  // Everything else is a percentage. These are not: if "mark that done" cannot
  // reach manage_tasks, Ari is broken in a way a user notices on day one.
  const critical = [
    ['manage_tasks', 'mark the report one as done'],
    ['set_reminder', 'nudge me at 6 about the passport thing'],
    ['view_calendar', 'what have I got on friday'],
    ['send_email', 'mail Priya the invoice'],
    ['manage_notes', 'jot this down: pricing goes up in march'],
  ];
  const broken = [];
  for (const [tool, says] of critical) {
    const selected = await selectAriTools(says, { recentMessages: [] });
    const names = (Array.isArray(selected) ? selected : selected?.tools || [])
      .map((entry) => entry?.function?.name || entry?.name);
    if (!names.includes(tool)) broken.push(`${tool} <- "${says}"`);
  }
  assert.deepEqual(broken, [], `everyday requests that cannot reach their tool:\n  ${broken.join('\n  ')}`);
});
