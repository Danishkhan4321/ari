'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATE_VERSION,
  compactConversationState,
  conversationIdentity,
  createOpenRouterAgentPersistence,
  mergeCanonicalHistory,
  mergeRecentChatHistory,
  safetyIdentifier,
} = require('../src/services/openrouter-agent-state.service');

function createMemoryQuery() {
  const states = new Map();
  const executions = new Map();
  const history = [];

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT state, state_version, updated_at')) {
      const row = states.get(params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('SELECT id, role, content, created_at')) {
      let rows = [...history];
      if (normalized.includes('session_id IS NULL')) {
        rows = rows.filter((row) => row.session_id == null);
      } else if (normalized.includes('session_id = $2::uuid')) {
        rows = rows.filter((row) => row.session_id === params[1]);
      }
      if (normalized.includes("created_at >= NOW()")) {
        const gapMs = Number(params.at(-2));
        rows = rows.filter((row) => new Date(row.created_at).getTime() >= Date.now() - gapMs);
      }
      if (normalized.includes('AND id >')) {
        const cursor = Number(params.at(-2)) || 0;
        rows = rows.filter((row) => Number(row.id) > cursor);
      }
      rows.sort((a, b) => Number(a.id) - Number(b.id));
      const limit = Number(params.at(-1)) || rows.length;
      return { rows: structuredClone(rows.slice(-limit)), rowCount: Math.min(rows.length, limit) };
    }
    if (normalized.startsWith('INSERT INTO ari_agent_conversation_state')) {
      states.set(params[0], {
        state: JSON.parse(params[4]),
        state_version: params[3],
        updated_at: new Date(),
        user_phone: params[1],
        session_id: params[2],
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO ari_agent_tool_executions')) {
      const key = `${params[0]}::${params[1]}`;
      if (executions.has(key)) return { rows: [], rowCount: 0 };
      executions.set(key, {
        tool_call_id: params[1],
        tool_name: params[2],
        arguments_hash: params[3],
        status: 'running',
        result: null,
        updated_at: new Date(),
      });
      return { rows: [{ tool_call_id: params[1] }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT tool_name, arguments_hash, status, result, updated_at')) {
      const row = executions.get(`${params[0]}::${params[1]}`);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('UPDATE ari_agent_tool_executions')) {
      const key = `${params[0]}::${params[1]}`;
      const row = executions.get(key);
      if (row) {
        row.status = params[2];
        row.result = JSON.parse(params[3]);
        row.updated_at = new Date();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('DELETE FROM ari_agent_tool_executions')) {
      for (const key of [...executions.keys()]) {
        if (key.startsWith(`${params[0]}::`)) executions.delete(key);
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('DELETE FROM ari_agent_conversation_state')) {
      const deleted = states.delete(params[0]);
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    throw new Error(`Unexpected SQL in persistence test: ${normalized.slice(0, 100)}`);
  }

  return { executions, history, query, states };
}

test('conversation and safety identities are stable, opaque, and isolated by session', () => {
  const phone = '919000000001';
  const rolling = conversationIdentity(phone);
  const sessionA = conversationIdentity(phone, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const sessionB = conversationIdentity(phone, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  assert.equal(conversationIdentity(phone), rolling);
  assert.notEqual(rolling, conversationIdentity('919000000002'));
  assert.notEqual(rolling, sessionA);
  assert.notEqual(sessionA, sessionB);
  assert.doesNotMatch(rolling, /919000000001/);
  assert.doesNotMatch(sessionA, /aaaaaaaa/);
  assert.equal(safetyIdentifier(phone), safetyIdentifier(phone));
  assert.notEqual(safetyIdentifier(phone), safetyIdentifier('919000000002'));
  assert.doesNotMatch(safetyIdentifier(phone), /919000000001/);
});

test('state load appends deterministic approval turns without dropping tool traces', () => {
  const state = {
    id: 'conversation-a',
    messages: [
      { role: 'user', content: 'Send the proposal' },
      { type: 'function_call', callId: 'call-1', name: 'send_email', arguments: '{}' },
      { type: 'function_call_output', callId: 'call-1', output: '{"status":"waiting_approval"}' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Approve sending the proposal?' }],
      },
    ],
  };
  const recent = {
    messages: [
      { role: 'user', content: 'Send the proposal' },
      { role: 'assistant', content: 'Approve sending the proposal?' },
      { role: 'user', content: 'yes' },
      { role: 'assistant', content: 'The proposal was sent.' },
    ],
  };

  const merged = mergeRecentChatHistory(state, recent);
  assert.equal(merged.messages[1].type, 'function_call');
  assert.deepEqual(merged.messages.slice(-2), [
    { role: 'user', content: 'yes' },
    { role: 'assistant', content: 'The proposal was sent.' },
  ]);
  assert.equal(state.messages.length, 4, 'stored state must not be mutated during load');
});

test('canonical history with no finite-window overlap is appended instead of forgotten', () => {
  const state = { id: 'old-state', messages: [{ role: 'assistant', content: 'Old SDK anchor' }] };
  const recent = Array.from({ length: 18 }, (_, index) => ({
      id: index + 10,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `deterministic turn ${index + 1}`,
    }));
  const merged = mergeCanonicalHistory(state, recent);
  assert.equal(merged.messages.length, 19);
  assert.equal(merged.messages.at(-1).content, 'deterministic turn 18');
});

test('cursor reconciliation does not drop a deterministic turn with repeated assistant text', () => {
  const state = {
    id: 'repeat-state',
    messages: [
      { role: 'user', content: 'Create the task' },
      { role: 'assistant', content: 'Done' },
    ],
  };
  const rows = [
    { id: 11, role: 'user', content: 'Create the task' },
    { id: 12, role: 'assistant', content: 'Done' },
    { id: 13, role: 'user', content: 'Mark the reminder complete' },
    { id: 14, role: 'assistant', content: 'Done' },
  ];

  const merged = mergeCanonicalHistory(state, rows);
  assert.deepEqual(merged.messages.slice(-2), [
    { role: 'user', content: 'Mark the reminder complete' },
    { role: 'assistant', content: 'Done' },
  ]);
  assert.equal(merged.ariHistoryCursor, 14);
});

test('durable history cursor reconciles every post-state turn beyond the recent window', async () => {
  const memory = createMemoryQuery();
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
    historyLimit: 100,
  });
  const conversationKey = conversationIdentity('919000000009');
  const accessor = persistence.createStateAccessor({
    conversationKey,
    userPhone: '919000000009',
    initialState: { id: conversationKey, messages: [] },
  });
  await accessor.save({
    id: conversationKey,
    status: 'complete',
    createdAt: 1,
    updatedAt: 1,
    ariHistoryCursor: 2,
    messages: [{ role: 'assistant', content: 'SDK state before deterministic workflow' }],
  });
  for (let id = 3; id <= 42; id += 1) {
    memory.history.push({
      id,
      role: id % 2 ? 'user' : 'assistant',
      content: `canonical turn ${id}`,
      created_at: new Date(),
    });
  }

  const loaded = await accessor.load();
  assert.equal(loaded.ariHistoryCursor, 42);
  assert.equal(loaded.messages.at(-1).content, 'canonical turn 42');
  assert.ok(loaded.messages.some((item) => item.content === 'canonical turn 3'));
});

test('rolling phone memory never ingests isolated dashboard-session history', async () => {
  const memory = createMemoryQuery();
  memory.history.push(
    { id: 1, role: 'user', content: 'WhatsApp-only context', session_id: null, created_at: new Date() },
    { id: 2, role: 'user', content: 'Secret dashboard context', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: new Date() }
  );
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
  });
  const conversationKey = conversationIdentity('919000000011');
  const accessor = persistence.createStateAccessor({
    conversationKey,
    userPhone: '919000000011',
    initialState: { id: conversationKey, messages: [] },
  });

  const loaded = await accessor.load();
  assert.deepEqual(loaded.messages, [{ role: 'user', content: 'WhatsApp-only context' }]);
  assert.equal(loaded.ariHistoryCursor, 1);
});

test('an expired rolling state cannot resurrect canonical history from before the session gap', async () => {
  const memory = createMemoryQuery();
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
    staleAfterMs: 1_000,
  });
  const userPhone = '919000000012';
  const conversationKey = conversationIdentity(userPhone);
  const accessor = persistence.createStateAccessor({
    conversationKey,
    userPhone,
    initialState: { id: conversationKey, messages: [{ role: 'assistant', content: 'Fresh session seed' }] },
  });
  await accessor.save({
    id: conversationKey, status: 'complete', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'assistant', content: 'Ancient SDK state' }],
  });
  memory.states.get(conversationKey).updated_at = new Date(Date.now() - 60_000);
  memory.history.push({
    id: 99,
    role: 'assistant',
    content: 'Ancient canonical history',
    session_id: null,
    created_at: new Date(Date.now() - 60_000),
  });

  const loaded = await accessor.load();
  assert.deepEqual(loaded.messages, [{ role: 'assistant', content: 'Fresh session seed' }]);
  assert.equal(loaded.ariHistoryCursor, undefined);
});

test('working state compaction is bounded and preserves recent tool pairs', () => {
  const messages = [];
  for (let index = 0; index < 80; index += 1) {
    messages.push({ role: 'user', content: `Request ${index}: ${'x'.repeat(250)}` });
    messages.push({ type: 'function_call', callId: `call-${index}`, name: 'manage_tasks', arguments: '{}' });
    messages.push({ type: 'function_call_output', callId: `call-${index}`, output: JSON.stringify({ status: 'success', task_id: index }) });
    messages.push({ role: 'assistant', content: `Completed ${index}` });
  }
  const compacted = compactConversationState({
    id: 'long-state', status: 'complete', createdAt: 1, updatedAt: 2,
    previousResponseId: 'must-be-cleared', messages,
  }, { maxItems: 30, maxChars: 20_000, checkpointChars: 2_000 });

  assert.ok(compacted.messages.length <= 30);
  assert.ok(JSON.stringify(compacted.messages).length <= 20_000);
  assert.match(compacted.messages[0].content, /Historical conversation checkpoint/);
  assert.equal(compacted.previousResponseId, undefined);
  const calls = new Set(compacted.messages.filter((item) => item.type === 'function_call').map((item) => item.callId));
  for (const output of compacted.messages.filter((item) => item.type === 'function_call_output')) {
    assert.ok(calls.has(output.callId), `orphan output ${output.callId}`);
  }
  assert.equal(compacted.messages.at(-1).content, 'Completed 79');
});

test('state accessors persist full SDK state without leaking it across sessions', async () => {
  const memory = createMemoryQuery();
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
  });
  const keyA = conversationIdentity('919000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const keyB = conversationIdentity('919000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const initialA = { id: keyA, messages: [{ role: 'user', content: 'A seed' }] };
  const initialB = { id: keyB, messages: [{ role: 'user', content: 'B seed' }] };
  const accessorA = persistence.createStateAccessor({
    conversationKey: keyA,
    userPhone: '919000000001',
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    initialState: initialA,
  });
  const accessorB = persistence.createStateAccessor({
    conversationKey: keyB,
    userPhone: '919000000001',
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    initialState: initialB,
  });

  const firstLoad = await accessorA.load();
  firstLoad.messages[0].content = 'mutated outside persistence';
  assert.equal((await accessorA.load()).messages[0].content, 'A seed', 'initial state must be cloned');

  const savedA = {
    id: keyA,
    previousResponseId: 'resp-a',
    messages: [
      { role: 'user', content: 'Create a task' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call-a' }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'call-a', output: { task_id: 'task-a' } }] },
    ],
  };
  await accessorA.save(savedA);

  assert.deepEqual(await accessorA.load(), savedA);
  assert.deepEqual(await accessorB.load(), initialB, 'another dashboard session must not see session A state');
  assert.equal(memory.states.get(keyA).state_version, STATE_VERSION);
  assert.equal(memory.states.get(keyA).session_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('tool journal claims once, replays a completed result, and rejects call-id argument drift', async () => {
  const memory = createMemoryQuery();
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
  });
  const conversationKey = conversationIdentity('919000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const claim = {
    conversationKey,
    callId: 'openrouter-call-1',
    toolName: 'manage_tasks',
    args: { title: 'Ship proposal' },
  };

  const first = await persistence.claimToolExecution(claim);
  assert.equal(first.claimed, true);
  await persistence.finishToolExecution({
    conversationKey,
    callId: claim.callId,
    status: 'completed',
    result: {
      status: 'success',
      ok: true,
      tool: 'manage_tasks',
      data: { task_id: 'task-42' },
      error: null,
      user_summary: 'Created task task-42.',
      evidence: [],
    },
  });

  const replay = await persistence.claimToolExecution(claim);
  assert.equal(replay.claimed, false);
  assert.equal(replay.conflict, null);
  assert.equal(replay.existing.status, 'completed');
  assert.equal(replay.existing.result.data.task_id, 'task-42');

  const drift = await persistence.claimToolExecution({ ...claim, args: { title: 'Delete proposal' } });
  assert.equal(drift.claimed, false);
  assert.equal(drift.conflict, 'arguments_mismatch');

  const isolated = await persistence.claimToolExecution({
    ...claim,
    conversationKey: conversationIdentity('919000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  });
  assert.equal(isolated.claimed, true, 'the same provider call id is independent in another session');
});

test('tool journal gives its reused status parameter one explicit PostgreSQL type', async () => {
  let capturedSql = '';
  let capturedParams = null;
  const persistence = createOpenRouterAgentPersistence({
    ensureSchema: false,
    pool: null,
    queryFn: async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return { rows: [], rowCount: 1 };
    },
  });

  await persistence.finishToolExecution({
    conversationKey: 'conversation-key',
    callId: 'tool-call-id',
    status: 'completed',
    result: { status: 'success', user_summary: 'Completed.' },
  });

  assert.match(capturedSql, /SET status = \$3::varchar/);
  assert.match(capturedSql, /WHEN \$3::varchar IN/);
  assert.deepEqual(capturedParams.slice(0, 3), ['conversation-key', 'tool-call-id', 'completed']);
});

test('clearConversation deletes durable SDK memory and its idempotency journal', async () => {
  const memory = createMemoryQuery();
  const persistence = createOpenRouterAgentPersistence({
    queryFn: memory.query,
    pool: null,
    ensureSchema: false,
  });
  const conversationKey = conversationIdentity('919000000001');
  const accessor = persistence.createStateAccessor({
    conversationKey,
    userPhone: '919000000001',
    initialState: { id: conversationKey, messages: [] },
  });
  await accessor.save({ id: conversationKey, messages: [{ role: 'user', content: 'secret chat' }] });
  await persistence.claimToolExecution({
    conversationKey,
    callId: 'clear-test-call',
    toolName: 'manage_tasks',
    args: { title: 'Secret task' },
  });

  await persistence.clearConversation({ conversationKey });
  assert.equal(memory.states.has(conversationKey), false);
  assert.equal(memory.executions.size, 0);
});
