'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../src/services/llm-provider');
const { vertexOpenApiModelName, normalizeVertexGemmaModel } = llm._internals;
const { toolCallsSignature } = require('../src/services/agent-loop.service');

// ── Vertex model-name mapping (Gemma + Gemini) ─────────────────────────────

test('vertexOpenApiModelName prefixes google/ for gemma AND gemini', () => {
  assert.equal(vertexOpenApiModelName('gemma-4-26b-a4b-it-maas'), 'google/gemma-4-26b-a4b-it-maas');
  assert.equal(vertexOpenApiModelName('gemini-2.5-flash'), 'google/gemini-2.5-flash');
  assert.equal(vertexOpenApiModelName('gemini-2.5-pro'), 'google/gemini-2.5-pro');
});

test('vertexOpenApiModelName leaves prefixed and foreign models alone', () => {
  assert.equal(vertexOpenApiModelName('google/gemini-2.5-flash'), 'google/gemini-2.5-flash');
  assert.equal(vertexOpenApiModelName('accounts/fireworks/models/qwen3p7-plus'), 'accounts/fireworks/models/qwen3p7-plus');
  assert.equal(vertexOpenApiModelName('mistral-large-3'), 'mistral-large-3');
  assert.equal(vertexOpenApiModelName(''), '');
});

test('normalizeVertexGemmaModel passes gemini models through unchanged', () => {
  assert.equal(normalizeVertexGemmaModel('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(normalizeVertexGemmaModel('google/gemini-2.5-pro'), 'google/gemini-2.5-pro');
  assert.equal(normalizeVertexGemmaModel('gemma-4-26b-a4b-it-maas'), 'gemma-4-26b-a4b-it-maas');
});

test('normalizeVertexGemmaModel rewrites non-Google models to the default', () => {
  const fallback = normalizeVertexGemmaModel('qwen3p7-plus');
  assert.ok(!/^qwen/.test(fallback), 'non-Google model must not pass through the Vertex path');
});

// ── Agent loop repeated-call guard signature ───────────────────────────────

function call(name, args, id = 'x') {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

test('toolCallsSignature is stable for identical calls and order-insensitive', () => {
  const a = toolCallsSignature([call('reminders_list', { limit: 5 })]);
  const b = toolCallsSignature([call('reminders_list', { limit: 5 }, 'other-id')]);
  assert.equal(a, b, 'same name+args must match regardless of call id');

  const multi1 = toolCallsSignature([call('a', { x: 1 }), call('b', { y: 2 })]);
  const multi2 = toolCallsSignature([call('b', { y: 2 }), call('a', { x: 1 })]);
  assert.equal(multi1, multi2, 'order must not matter');
});

test('toolCallsSignature differs when name or args differ', () => {
  const base = toolCallsSignature([call('search', { text: 'meera' })]);
  assert.notEqual(base, toolCallsSignature([call('search', { text: 'raj' })]));
  assert.notEqual(base, toolCallsSignature([call('search_leads', { text: 'meera' })]));
});

test('toolCallsSignature returns null for empty input (never self-matches)', () => {
  assert.equal(toolCallsSignature([]), null);
  assert.equal(toolCallsSignature(null), null);
  assert.equal(toolCallsSignature(undefined), null);
});
