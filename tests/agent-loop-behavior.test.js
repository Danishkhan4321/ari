'use strict';

/**
 * Behavioral tests for the agent loop and Vertex routing that do NOT need a
 * database, network, or real model:
 *
 * 1. Drives runAgentLoop end-to-end with a scripted fake LLM to prove the
 *    repeated-identical-call guard blocks re-execution and the loop still
 *    finishes with the model's final text.
 * 2. Intercepts the HTTP layer to prove chatCompletion routes
 *    gemini-* + LLM_PROVIDER=vertex_gemma to the Vertex OpenAI-compatible
 *    endpoint with google/-prefixed model naming.
 */

// Env MUST be set before llm-provider is first required (module-load snapshot).
process.env.LLM_PROVIDER = 'vertex_gemma';
process.env.GOOGLE_VERTEX_PROJECT = 'test-project';
process.env.GOOGLE_VERTEX_LOCATION = 'global';
process.env.GOOGLE_VERTEX_ACCESS_TOKEN = 'test-token';
process.env.GEMINI_API_KEY = 'should-be-ignored-when-vertex-is-explicit';
process.env.VERTEX_GEMMA_MODEL = 'gemini-2.5-flash';
process.env.MODEL_AGENT_PRIMARY = 'gemma-agent-primary';
process.env.MODEL_AGENT_ESCALATE = 'gemma-agent-escalate';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const llm = require('../src/services/llm-provider');
const { runAgentLoop } = require('../src/services/agent-loop.service');

function fakeResponse(message) {
  return { data: { choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'reminders_list',
    description: 'List pending reminders',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
}];

test('agent loop: identical repeated tool call is blocked, loop still completes', async (t) => {
  const identicalCall = { id: 'c1', type: 'function', function: { name: 'reminders_list', arguments: '{"limit":5}' } };
  const script = [
    fakeResponse({ role: 'assistant', content: null, tool_calls: [identicalCall] }),
    fakeResponse({ role: 'assistant', content: null, tool_calls: [{ ...identicalCall, id: 'c2' }] }),
    fakeResponse({ role: 'assistant', content: 'You have 1 reminder: call mom at 5pm.' }),
  ];

  let llmCalls = 0;
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => script[Math.min(llmCalls++, script.length - 1)];
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  let executions = 0;
  const outcome = await runAgentLoop({
    userMessage: 'show my reminders twice please',
    userPhone: '911000000099',
    tools: TOOLS,
    // NOTE: returns structured data WITHOUT a string `result` field so the
    // loop's single-tool short-circuit doesn't end the turn at step 0 —
    // we need the loop to continue so the guard can face the repeat.
    executeFn: async (name) => { executions += 1; return { ok: true, tool: name, items: ['call mom 5pm'] }; },
    backgroundBlock: '', // skip context-builder (no DB in tests)
    recentMessages: [],
  });

  assert.equal(executions, 1, 'second identical tool call must NOT execute');
  assert.equal(llmCalls, 3, 'loop should continue to a final answer after the guard');
  assert.match(outcome.text, /call mom/i);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.toolsUsed, ['reminders_list'], 'guarded call must not be counted as used');
});

test('agent loop: a waiting_input tool result stops the loop (confirmation gate is enforced)', async (t) => {
  // A tool that returns waiting_input (e.g. the delete-all confirmation gate)
  // is terminal for the turn. The loop must surface its question and STOP —
  // it must never issue another LLM step, or the model could re-call the tool
  // with confirm=true and self-approve an irreversible action in one turn.
  const DELETE_TOOL = [{
    type: 'function',
    function: { name: 'manage_contact_groups', description: 'CRM groups', parameters: { type: 'object', properties: {} } },
  }];
  let llmCalls = 0;
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => {
    llmCalls += 1;
    // Step 0: the model asks to delete all groups (no confirm). If the loop
    // wrongly continued, a step-1 call here would let it send confirm=true.
    return fakeResponse({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'd1', type: 'function', function: { name: 'manage_contact_groups', arguments: '{"action":"delete","delete_all":true}' } }],
    });
  };
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  let deletions = 0;
  const outcome = await runAgentLoop({
    userMessage: 'delete all my crm groups',
    userPhone: '911000000099',
    tools: DELETE_TOOL,
    executeFn: async (name, args) => {
      if (args && args.confirm === true) { deletions += 1; return { status: 'success', tool: name, user_summary: 'deleted' }; }
      return { status: 'waiting_input', tool: name, user_summary: 'This permanently deletes all 2 groups. Should I go ahead?' };
    },
    backgroundBlock: '',
    recentMessages: [],
  });

  assert.equal(llmCalls, 1, 'loop must stop after the waiting_input tool result — no second LLM step');
  assert.equal(deletions, 0, 'nothing may be deleted without explicit user confirmation');
  assert.equal(outcome.status, 'waiting_for_user');
  assert.match(outcome.text, /should i go ahead/i);
});

test('agent loop: single-tool string result short-circuits without a second LLM call', async (t) => {
  let llmCalls = 0;
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => {
    llmCalls += 1;
    return fakeResponse({ role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'reminders_list', arguments: '{}' } }] });
  };
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const outcome = await runAgentLoop({
    userMessage: 'show my reminders',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => ({ ok: true, tool: 'reminders_list', result: '📋 1 reminder: call mom 5pm' }),
    backgroundBlock: '',
  });

  assert.equal(llmCalls, 1, 'formatted string result must skip the paraphrase call');
  assert.match(outcome.text, /call mom/);
});

test('agent loop: chained request does not short-circuit after its first tool', async (t) => {
  const script = [
    fakeResponse({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'chain-1', type: 'function', function: { name: 'reminders_list', arguments: '{}' } }],
    }),
    fakeResponse({ role: 'assistant', content: 'Summary: call mom at 5pm.' }),
  ];
  let llmCalls = 0;
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => script[Math.min(llmCalls++, script.length - 1)];
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const outcome = await runAgentLoop({
    userMessage: 'find my reminders and summarize them',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => ({ ok: true, result: '1 reminder: call mom at 5pm' }),
    backgroundBlock: '',
  });

  assert.equal(llmCalls, 2, 'the model must see the first tool result and finish the chain');
  assert.equal(outcome.shortCircuited, undefined);
  assert.match(outcome.text, /^Summary:/);
});

test('agent loop: successful multi-tool progress does not escalate the model', async (t) => {
  const script = [
    ...Array.from({ length: 4 }, (_, index) => fakeResponse({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `progress-${index}`,
        type: 'function',
        function: { name: 'reminders_list', arguments: JSON.stringify({ limit: index + 1 }) },
      }],
    })),
    fakeResponse({ role: 'assistant', content: 'All four steps completed.' }),
  ];
  let llmCalls = 0;
  const models = [];
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async (body) => {
    models.push(body.model);
    return script[Math.min(llmCalls++, script.length - 1)];
  };
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const outcome = await runAgentLoop({
    userMessage: 'check each reminder and prepare a report',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async (_name, args) => ({ ok: true, data: { limit: args.limit } }),
    backgroundBlock: '',
  });

  assert.equal(llmCalls, 5);
  assert.deepEqual(models, Array(5).fill('gemma-agent-primary'));
  assert.equal(outcome.escalated, false);
});

test('agent loop: consecutive tool failures escalate the model', async (t) => {
  const script = [
    ...Array.from({ length: 3 }, (_, index) => fakeResponse({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `failure-${index}`,
        type: 'function',
        function: { name: 'reminders_list', arguments: JSON.stringify({ limit: index + 1 }) },
      }],
    })),
    fakeResponse({ role: 'assistant', content: 'I could not complete that request.' }),
  ];
  let llmCalls = 0;
  const models = [];
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async (body) => {
    models.push(body.model);
    return script[Math.min(llmCalls++, script.length - 1)];
  };
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const outcome = await runAgentLoop({
    userMessage: 'try to check these reminders',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => ({ ok: false, error: 'calendar backend unavailable' }),
    backgroundBlock: '',
  });

  assert.deepEqual(models, [
    'gemma-agent-primary',
    'gemma-agent-primary',
    'gemma-agent-primary',
    'gemma-agent-escalate',
  ]);
  assert.equal(outcome.escalated, true);
});

test('agent loop emits safe lifecycle events for a successful tool run', async (t) => {
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => fakeResponse({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'evt-1', type: 'function', function: { name: 'reminders_list', arguments: '{}' } }],
  });
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const events = [];
  const outcome = await runAgentLoop({
    runId: '11111111-1111-4111-8111-111111111111',
    userMessage: 'show my reminders',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => '1 reminder: call mom at 5pm',
    backgroundBlock: '',
    onEvent: async (event) => { events.push(event); },
  });

  assert.match(outcome.text, /call mom/i);
  assert.deepEqual(events.map((event) => event.type), [
    'run.started',
    'tool.requested',
    'tool.started',
    'tool.succeeded',
    'run.completed',
  ]);
  assert.equal(events[2].toolName, 'reminders_list');
  assert.equal(events[3].payload.status, 'success');
  assert.doesNotMatch(JSON.stringify(events), /test-key/);
});

test('agent loop marks provider failures and emits a failed terminal event', async (t) => {
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => { throw new Error('provider unavailable'); };
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  const events = [];
  const outcome = await runAgentLoop({
    runId: '22222222-2222-4222-8222-222222222222',
    userMessage: 'show my reminders',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => 'unused',
    backgroundBlock: '',
    onEvent: async (event) => { events.push(event); },
  });

  assert.equal(outcome.status, 'failed');
  assert.ok(['model_error', 'circuit_breaker_open'].includes(outcome.errorCode));
  assert.deepEqual(events.map((event) => event.type), ['run.started', 'run.failed']);
  assert.equal(events[1].payload.code, outcome.errorCode);
});

test('agent loop: different arguments are NOT blocked by the guard', async (t) => {
  const script = [
    fakeResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'reminders_list', arguments: '{"limit":5}' } }] }),
    fakeResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'reminders_list', arguments: '{"limit":10}' } }] }),
    fakeResponse({ role: 'assistant', content: 'Done.' }),
  ];
  let llmCalls = 0;
  const realChat = llm.chatCompletion;
  const realKey = llm.apiKey;
  llm.chatCompletion = async () => script[Math.min(llmCalls++, script.length - 1)];
  llm.apiKey = () => 'test-key';
  t.after(() => { llm.chatCompletion = realChat; llm.apiKey = realKey; });

  let executions = 0;
  const outcome = await runAgentLoop({
    userMessage: 'list more reminders',
    userPhone: '911000000099',
    tools: TOOLS,
    executeFn: async () => { executions += 1; return { ok: true, count: executions }; },
    backgroundBlock: '',
  });

  assert.equal(executions, 2, 'different args must both execute');
  assert.equal(outcome.text, 'Done.');
});

test('chatCompletion routes gemini-* through Vertex with google/ naming when provider is vertex_gemma', async (t) => {
  const captured = [];
  const realPost = axios.post;
  axios.post = async (url, body) => {
    captured.push({ url, body });
    return fakeResponse({ role: 'assistant', content: 'hi from vertex' });
  };
  t.after(() => { axios.post = realPost; });

  const requestMessages = [
    { role: 'system', content: 'cached prompt', _cachePoint: true, _traceId: 'internal-only' },
    { role: 'user', content: 'ping' },
  ];
  const resp = await llm.chatCompletion({
    model: 'gemini-2.5-flash',
    messages: requestMessages,
    tools: TOOLS,
    tool_choice: 'auto',
  });

  assert.equal(captured.length, 1, 'exactly one HTTP call');
  assert.match(captured[0].url, /aiplatform\.googleapis\.com/, 'must hit Vertex, not the Gemini API-key endpoint');
  assert.match(captured[0].url, /endpoints\/openapi\/chat\/completions/);
  assert.equal(captured[0].body.model, 'google/gemini-2.5-flash', 'model must be google/-prefixed for Vertex');
  assert.ok(Array.isArray(captured[0].body.tools), 'tools must pass through to Vertex');
  assert.equal(captured[0].body.tool_choice, 'auto', 'tool_choice must pass through');
  assert.equal(captured[0].body.messages[0]._cachePoint, undefined, 'internal cache markers must not reach raw provider payloads');
  assert.equal(captured[0].body.messages[0]._traceId, undefined, 'other internal message fields must also be stripped');
  assert.equal(requestMessages[0]._cachePoint, true, 'sanitizing must not mutate the caller input');
  assert.equal(resp.data.choices[0].message.content, 'hi from vertex');
});

test('chatCompletion keeps gemma models on the Vertex path unchanged', async (t) => {
  const captured = [];
  const realPost = axios.post;
  axios.post = async (url, body) => {
    captured.push({ url, body });
    return fakeResponse({ role: 'assistant', content: 'gemma ok' });
  };
  t.after(() => { axios.post = realPost; });

  await llm.chatCompletion({
    model: 'gemma-4-26b-a4b-it-maas',
    messages: [{ role: 'user', content: 'ping' }],
  });

  assert.match(captured[0].url, /aiplatform\.googleapis\.com/);
  assert.equal(captured[0].body.model, 'google/gemma-4-26b-a4b-it-maas');
});
