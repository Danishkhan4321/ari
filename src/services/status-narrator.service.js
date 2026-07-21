'use strict';

// LLM-generated one-line status updates for the live activity feed.
//
// Replaces hardcoded "Running manage tasks" strings with task-specific lines
// like "Looking up your CRM groups…". Codex-style rules apply:
//   - summaries only — never chain-of-thought, never raw tool payloads;
//     the model sees ONLY the tool name, argument NAMES, and a snippet of the
//     user's own request (whitelisted fields, no values);
//   - fire-and-forget — the agent loop never waits on this; if the line is
//     not ready, the UI keeps the deterministic fallback string;
//   - cheap — fast model, thinking disabled, ~24 output tokens, cached per
//     (tool, request) so retries and loops don't re-bill.

const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');

const lineCache = new BoundedMap(2000, 10 * 60 * 1000);

function cacheKey(toolName, userMessage) {
  return `${toolName}::${String(userMessage || '').slice(0, 80).toLowerCase()}`;
}

function sanitizeLine(raw) {
  const line = String(raw || '')
    .split('\n')[0]
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .slice(0, 90);
  // A usable status line is short, single-sentence, and non-empty.
  if (!line || line.length < 4) return null;
  return line;
}

/**
 * Generate a status line for a starting tool. Resolves fast or null — never
 * throws, never blocks longer than ~1.5s.
 *
 * @param {object} input { toolName, argNames, userMessage }
 * @returns {Promise<string|null>}
 */
async function narrateToolStart({ toolName, argNames = [], userMessage = '' }) {
  const key = cacheKey(toolName, userMessage);
  const cached = lineCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const llm = require('./llm-provider');
    const response = await llm.chatCompletion({
      model: llm.fastModel(),
      messages: [
        {
          role: 'system',
          content: 'You write ONE short status line shown in a UI while an assistant works on the user\'s request. Present tense, at most 10 words, no quotes, no trailing period. Describe the action in the user\'s terms. Never mention internal reasoning, tools, JSON, or system details.',
        },
        {
          role: 'user',
          content: `Action: ${String(toolName).replace(/_/g, ' ')}\nArgument names: ${argNames.slice(0, 8).join(', ') || 'none'}\nThe user asked: "${String(userMessage).slice(0, 120)}"\nStatus line:`,
        },
      ],
      max_tokens: 24,
      temperature: 0.3,
      ...llm.defaultBodyExtras('default'),
    }, { task: 'status_narration', timeout: 1500 });
    const line = sanitizeLine(response?.data?.choices?.[0]?.message?.content);
    lineCache.set(key, line);
    return line;
  } catch (error) {
    logger.debug({ toolName, err: error.message }, 'status narrator skipped');
    lineCache.set(key, null); // do not retry a failing narrator every tool call
    return null;
  }
}

module.exports = { narrateToolStart, _internals: { sanitizeLine, cacheKey } };
