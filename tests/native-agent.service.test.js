'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNativeAgentService } = require('../src/services/native-agent.service');
const { listTools } = require('../src/mcp/desktop-tool-registry');

function fakePersistence() {
  const calls = [];
  return {
    calls,
    ensureTables: async () => { calls.push({ kind: 'ensure' }); },
    withConversationLock: async (conversationKey, work) => {
      calls.push({ kind: 'lock', conversationKey });
      return work(async () => ({ rows: [], rowCount: 0 }));
    },
    claimToolExecution: async (input) => {
      calls.push({ kind: 'claim', input });
      return { claimed: true, argumentsHash: 'hash' };
    },
    finishToolExecution: async (input) => { calls.push({ kind: 'finish', input }); },
  };
}

function configuredEnv(extra = {}) {
  return {
    ARI_AGENT_RUNTIME: 'native',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    GOOGLE_VERTEX_PROJECT: 'test-project',
    MODEL_AGENT_PRIMARY: 'gemini-2.5-flash',
    ARI_AGENT_TOOL_TIMEOUT_MS: '1000',
    ...extra,
  };
}

function scriptedChat(responses, calls = []) {
  return async (body, opts) => {
    calls.push({ body, opts });
    const next = responses.shift();
    if (!next) throw new Error('scripted chatCompletion exhausted');
    if (next instanceof Error) throw next;
    return { data: { choices: [{ message: next }], usage: { total_tokens: 42 } } };
  };
}

test('native runtime requires the native flag, storage, and Gemini/Vertex credentials', () => {
  assert.equal(createNativeAgentService({ env: configuredEnv() }).isConfigured(), true);
  assert.equal(createNativeAgentService({
    env: configuredEnv({ GOOGLE_VERTEX_PROJECT: '', GEMINI_API_KEY: 'k' }),
  }).isConfigured(), true);
  assert.equal(createNativeAgentService({
    env: configuredEnv({ ARI_AGENT_RUNTIME: 'agno' }),
  }).isConfigured(), false);
  assert.equal(createNativeAgentService({
    env: configuredEnv({ DATABASE_URL: '' }),
  }).isConfigured(), false);
  assert.equal(createNativeAgentService({
    env: configuredEnv({ GOOGLE_VERTEX_PROJECT: '' }),
  }).isConfigured(), false);
});

test('single successful tool short-circuits to one model call', async () => {
  const chatCalls = [];
  const persistence = fakePersistence();
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence,
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'latest node LTS' }) },
        }],
      },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900001',
    userMessage: 'search the web for the latest node LTS',
    executeFn: async () => ({
      status: 'success',
      user_summary: 'Node 24 is the current LTS.',
      data: { top: 'nodejs.org' },
    }),
  });

  assert.equal(chatCalls.length, 1, 'short-circuit must not make a second model call');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Node 24 is the current LTS.');
  assert.equal(outcome.steps, 1);
  assert.deepEqual(outcome.toolsUsed, ['web_search']);
  assert.match(outcome.finalModel, /^vertex-gemini:gemini-2\.5-flash$/);
  assert.equal(outcome.engine, 'native-gemini');
  assert.ok(persistence.calls.some((c) => c.kind === 'claim'));
  assert.ok(persistence.calls.some((c) => c.kind === 'finish' && c.input.status === 'completed'));
});

test('a tool result without a summary flows into a second model round for the final text', async () => {
  const chatCalls = [];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'manage_notes', arguments: JSON.stringify({ action: 'list' }) },
        }],
      },
      { role: 'assistant', content: 'You have two notes: Standup and Launch.' },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900002',
    userMessage: 'what notes do I have?',
    executeFn: async () => ({ status: 'success', data: { notes: ['Standup', 'Launch'] } }),
  });

  assert.equal(chatCalls.length, 2);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'You have two notes: Standup and Launch.');
});

test('a confirmation-gate transition latches waiting_approval and stops the loop', async () => {
  const chatCalls = [];
  let pendingIdentity = null;
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    confirmationGate: { pendingIdentity: () => pendingIdentity },
    chatCompletion: scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'save_memory', arguments: JSON.stringify({ fact: 'user prefers evening demos' }) },
        }],
      },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900003',
    userMessage: 'remember that I prefer evening demos',
    executeFn: async () => {
      pendingIdentity = '12:agent_tool:save_memory';
      return 'Save this memory? Reply yes to confirm.';
    },
  });

  assert.equal(chatCalls.length, 1);
  assert.equal(outcome.status, 'waiting_approval');
  assert.equal(outcome.text, 'Save this memory? Reply yes to confirm.');
});

test('invalid tool arguments become a typed retryable failure the model can correct', async () => {
  const chatCalls = [];
  const executed = [];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'web_search', arguments: JSON.stringify({ wrong_field: 'x' }) },
        }],
      },
      { role: 'assistant', content: 'I could not run that search.' },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900004',
    userMessage: 'look this up online',
    executeFn: async (name) => { executed.push(name); return { status: 'success' }; },
  });

  assert.equal(executed.length, 0, 'invalid args must never reach the business executor');
  assert.equal(chatCalls.length, 2);
  assert.equal(outcome.toolResults[0].error.code, 'invalid_tool_arguments');
  assert.equal(outcome.toolResults[0].error.retryable, true);
});

test('aborting mid-mutation journals an unknown outcome and returns partial', async () => {
  const controller = new AbortController();
  const persistence = fakePersistence();
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence,
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'save_memory', arguments: JSON.stringify({ fact: 'slow fact' }) },
        }],
      },
    ]),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900005',
    userMessage: 'remember this slow fact',
    signal: controller.signal,
    executeFn: () => new Promise(() => {
      setTimeout(() => controller.abort(new Error('user pressed stop')), 30);
    }),
  });

  assert.equal(outcome.status, 'partial');
  assert.match(outcome.text, /without a confirmed outcome/);
  const finish = persistence.calls.find((c) => c.kind === 'finish');
  assert.equal(finish.input.status, 'unknown');
});

test('an aborted run before any model call raises agent_cancelled', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([]),
  });

  await assert.rejects(
    service.runAgentLoop({
      userPhone: '919999900006',
      userMessage: 'anything',
      signal: controller.signal,
      executeFn: async () => ({ status: 'success' }),
    }),
    (error) => error.code === 'agent_cancelled',
  );
});

test('compound requests split into parallel branches and merge their results', async () => {
  const chatCalls = [];
  const responses = [
    // 1) planning call
    { role: 'assistant', content: JSON.stringify({ subtasks: [
      { text: 'add a note about the launch plan details', depends_on: [] },
      { text: 'set a reminder to review it at 6pm today', depends_on: [] },
    ] }) },
    // 2+3) one tool_call per branch (assignment order races — both are valid)
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', function: { name: 'save_memory', arguments: JSON.stringify({ fact: 'launch plan noted' }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', function: { name: 'web_search', arguments: JSON.stringify({ query: 'review reminder best time' }) } }] },
  ];
  const persistence = fakePersistence();
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence,
    buildContext: async () => '',
    chatCompletion: async (body, opts) => {
      chatCalls.push({ body, opts });
      const next = responses.shift();
      if (!next) throw new Error('scripted chatCompletion exhausted');
      return { data: { choices: [{ message: next }], usage: { total_tokens: 21 } } };
    },
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900007',
    userMessage: 'add a note about the launch plan and set a reminder to review it at 6pm',
    executeFn: async (name) => ({ status: 'success', user_summary: `[${name}] done.`, data: {} }),
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.meta.compoundSubtasks, 2);
  assert.equal(outcome.steps, 2, 'one tool per branch');
  assert.deepEqual([...outcome.toolsUsed].sort(), ['save_memory', 'web_search']);
  assert.match(outcome.text, /\[save_memory\] done\./);
  assert.match(outcome.text, /\[web_search\] done\./);
  // Branch call IDs are namespaced so parallel branches cannot collide in the
  // idempotency journal despite Gemini reusing call_0 in both.
  const claimedIds = persistence.calls.filter((c) => c.kind === 'claim').map((c) => c.input.callId);
  assert.deepEqual([...claimedIds].sort(), ['s1:call_0', 's2:call_0']);
  assert.equal(chatCalls.length, 3, 'planning + one round per branch (short-circuited)');
});

test('a compound branch pausing for approval does not kill the other branch', async () => {
  let pendingIdentity = null;
  const responses = [
    { role: 'assistant', content: JSON.stringify({ subtasks: [
      { text: 'save a memory that the launch is on friday', depends_on: [] },
      { text: 'look up the launch checklist online now', depends_on: [] },
    ] }) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', function: { name: 'save_memory', arguments: JSON.stringify({ fact: 'launch friday' }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', function: { name: 'web_search', arguments: JSON.stringify({ query: 'launch checklist' }) } }] },
  ];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    confirmationGate: { pendingIdentity: () => pendingIdentity },
    chatCompletion: async () => {
      const next = responses.shift();
      if (!next) throw new Error('exhausted');
      return { data: { choices: [{ message: next }], usage: {} } };
    },
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900008',
    userMessage: 'save a memory that the launch is on friday and look up the launch checklist online',
    executeFn: async (name) => {
      if (name === 'save_memory') {
        pendingIdentity = '12:agent_tool:save_memory';
        return 'Save this memory? Reply yes to confirm.';
      }
      return { status: 'success', user_summary: `[${name}] done.`, data: {} };
    },
  });

  assert.equal(outcome.status, 'waiting_approval', 'one pending branch pends the merged run');
  assert.match(outcome.text, /Reply yes to confirm/);
  assert.match(outcome.text, /\[web_search\] done\./, 'the independent branch still completed');
});

test('every registered tool contract compiles into an OpenAI-compatible function tool', () => {
  const tools = listTools();
  assert.ok(tools.length >= 50, `expected a full registry, got ${tools.length}`);
  for (const tool of tools) {
    assert.ok(tool.name && /^[a-z0-9_]+$/i.test(tool.name), `bad tool name: ${tool.name}`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.trim().length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} schema must be an object schema`);
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object',
      `${tool.name} schema must declare properties`);
    // Gemini's OpenAI-compat endpoint rejects schemas that are not valid JSON.
    assert.doesNotThrow(() => JSON.stringify(tool.inputSchema), `${tool.name} schema must serialize`);
  }
});

// ── narrated-but-never-executed, and the recovery ───────────────────────
// Found by the e2e journey against a live database: a few turns into a
// conversation the model replies "Task marked as done" having called nothing.
// Nothing mutates without a tool call, so the claim is false by construction.
test('a mutation claimed with no tool call triggers one corrective round that actually acts', async () => {
  const chatCalls = [];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      // Round 1: narration only — no tool_calls at all.
      { role: 'assistant', content: 'Marked the e2e release notes task as done.' },
      // Round 2, after the nudge: it actually calls the tool.
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'manage_tasks', arguments: JSON.stringify({ action: 'complete', task_title: 'e2e release notes' }) },
        }],
      },
      // Round 3: the summary round. The single-tool short-circuit only applies
      // on the first round, so a recovered turn costs one extra model call —
      // the correct trade for not lying to the user.
      { role: 'assistant', content: 'Task completed.' },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900002',
    userMessage: 'mark the e2e release notes task as done',
    executeFn: async () => ({ status: 'success', user_summary: 'Task completed.' }),
  });

  assert.equal(chatCalls.length, 3, 'narration -> nudge -> tool call -> summary');
  assert.deepEqual(outcome.toolsUsed, ['manage_tasks'], 'the corrective round must actually call the tool');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Task completed.');

  // The nudge must name the failure plainly so the model can act on it.
  // (The captured body holds a live reference to the messages array, so find
  // the nudge by content rather than by position.)
  const nudge = chatCalls[1].body.messages.find(
    (m) => m.role === 'user' && /did not call any tool/i.test(String(m.content || '')),
  );
  assert.ok(nudge, 'the corrective round must tell the model it called nothing');
});

test('narration-only that is NOT a mutation claim ends the turn without a retry', async () => {
  const chatCalls = [];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      { role: 'assistant', content: 'You have three reminders today.' },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900003',
    userMessage: 'how many reminders do I have',
    executeFn: async () => ({ status: 'success', user_summary: 'unused' }),
  });

  assert.equal(chatCalls.length, 1, 'a plain answer must not be retried');
  assert.equal(outcome.text, 'You have three reminders today.');
  assert.equal(outcome.status, 'completed');
});

test('if the corrective round still refuses to act, the false claim is never relayed', async () => {
  const chatCalls = [];
  const service = createNativeAgentService({
    env: configuredEnv(),
    persistence: fakePersistence(),
    buildContext: async () => '',
    chatCompletion: scriptedChat([
      { role: 'assistant', content: 'Marked the task as done.' },
      { role: 'assistant', content: 'Marked the task as done.' },
    ], chatCalls),
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919999900004',
    userMessage: 'mark the task as done',
    executeFn: async () => ({ status: 'success', user_summary: 'unused' }),
  });

  assert.equal(chatCalls.length, 2, 'exactly one corrective round, never a loop');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.text, /did not actually run/i);
  assert.doesNotMatch(outcome.text, /Marked the task as done/i);
});
