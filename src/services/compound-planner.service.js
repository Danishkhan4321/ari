'use strict';

// Plan-then-execute decomposition for compound user requests
// ("remind me X, email Y, and add a task Z").
//
// Shape follows the orchestrator-worker lessons from production systems:
// ONE cheap planning call produces a small dependency DAG (≤3 subtasks);
// independent subtasks execute concurrently through the SAME tool executor
// machinery (never separate full agents — assistant subtasks are cheap CRUD,
// and full multi-agent fan-out costs ~15× tokens for nothing). Anything
// uncertain falls back to the ordinary single loop.

const logger = require('../utils/logger');

const MAX_SUBTASKS = 3;

// Cheap structural signal that a message contains more than one instruction.
// The planner model makes the real call; this just gates the extra call.
const ACTION_VERBS = 'send|add|create|set|schedule|remind|email|delete|update|move|save|look|search|draft|book|cancel';
const COMPOUND_HINT = new RegExp(
  [
    '\\b(and (then|also|after that))\\b',
    `\\b(then|afterwards|after that)\\b.{3,}\\b(${ACTION_VERBS})\\b`,
    // verb … and [also/then] verb — the classic two-instruction shape
    `\\b(${ACTION_VERBS})\\b.{3,}?\\band\\b\\s+(?:also\\s+|then\\s+)?(${ACTION_VERBS})\\b`,
    `;\\s*(also|and)?\\s*\\b(${ACTION_VERBS})\\b`,
  ].join('|'),
  'i',
);

function detectCompound(text) {
  const value = String(text || '');
  if (value.length < 24 || value.length > 2000) return false;
  return COMPOUND_HINT.test(value);
}

function sanitizePlan(raw, originalText) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { return null; }
  }
  const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : null;
  if (!subtasks || subtasks.length < 2 || subtasks.length > MAX_SUBTASKS) return null;
  const cleaned = subtasks.map((task, index) => ({
    id: index + 1,
    text: String(task?.text || '').trim().slice(0, 600),
    dependsOn: (Array.isArray(task?.depends_on) ? task.depends_on : [])
      .map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= index),
  }));
  if (cleaned.some((task) => task.text.length < 5)) return null;
  // A plan that dropped or invented content is worse than no plan: require
  // rough length parity with the original request.
  const totalLength = cleaned.reduce((sum, task) => sum + task.text.length, 0);
  if (totalLength < String(originalText || '').length * 0.3) return null;
  return cleaned;
}

/**
 * Decompose a compound request. Resolves with subtasks [{id, text, dependsOn}]
 * or null (caller falls back to the single loop). Never throws.
 */
async function planSubtasks(userMessage, { chatCompletion, model, signal } = {}) {
  try {
    const llm = require('./llm-provider');
    const call = chatCompletion || llm.chatCompletion;
    const response = await call({
      model: model || llm.fastModel(),
      messages: [
        {
          role: 'system',
          content: [
            'Split the user request into independent subtasks for an assistant to execute.',
            `Return ONLY JSON: {"subtasks":[{"text":"...","depends_on":[]}]} with 2-${MAX_SUBTASKS} items.`,
            'Each text must be a self-contained instruction preserving the user\'s exact details (names, times, content).',
            'Use depends_on (1-based indexes of EARLIER subtasks) only when one subtask needs another\'s result.',
            'If the request is really one task, return {"subtasks":[]}.',
          ].join('\n'),
        },
        { role: 'user', content: String(userMessage).slice(0, 1500) },
      ],
      max_tokens: 400,
      temperature: 0,
      ...llm.defaultBodyExtras('default'),
    }, { task: 'compound_plan', timeout: 4000, signal });
    const content = response?.data?.choices?.[0]?.message?.content || '';
    return sanitizePlan(content, userMessage);
  } catch (error) {
    logger.warn({ err: error.message }, 'compound planning skipped');
    return null;
  }
}

/** Group subtasks into sequential waves of parallel-safe branches. */
function planWaves(subtasks) {
  const waves = [];
  const done = new Set();
  let remaining = [...subtasks];
  while (remaining.length > 0) {
    const ready = remaining.filter((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (ready.length === 0) return null; // cycle — refuse the plan
    waves.push(ready);
    for (const task of ready) done.add(task.id);
    remaining = remaining.filter((task) => !ready.includes(task));
  }
  return waves;
}

module.exports = { detectCompound, planSubtasks, planWaves, sanitizePlan, MAX_SUBTASKS };
