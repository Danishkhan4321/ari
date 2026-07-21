'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentConversationSummaryService,
} = require('../src/services/agent-conversation-summary.service');

function fakeDatabase({ count = 0, maxId = null, existing = null, messages = [] } = {}) {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (/CREATE TABLE IF NOT EXISTS ari_agent_conversation_summaries/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/COUNT\(\*\).*conversation_history/is.test(sql)) {
      return { rows: [{ message_count: count, last_history_id: maxId }], rowCount: 1 };
    }
    if (/SELECT summary, source_message_count/i.test(sql)) {
      return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
    }
    if (/SELECT id, role, content/i.test(sql)) {
      return { rows: messages, rowCount: messages.length };
    }
    return { rows: [], rowCount: 1 };
  };
  return { calls, queryFn };
}

test('short conversations do not create a cross-provider summary', async () => {
  const db = fakeDatabase({ count: 4, maxId: 4, existing: { summary: 'stale' } });
  let summarized = 0;
  const service = createAgentConversationSummaryService({
    queryFn: db.queryFn,
    minMessages: 12,
    summarize: async () => { summarized++; return 'unused'; },
  });

  const context = await service.getContext({
    userPhone: '919999999921',
    sessionId: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(context, '');
  assert.equal(summarized, 0);
  assert.ok(db.calls.some((call) => /DELETE FROM ari_agent_conversation_summaries/i.test(call.sql)));
});

test('a stale long conversation is summarized and upserted for provider handoff', async () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({
    id: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
  }));
  const db = fakeDatabase({ count: 14, maxId: 14, messages });
  let summaryInput;
  const service = createAgentConversationSummaryService({
    queryFn: db.queryFn,
    minMessages: 12,
    summarize: async (input) => { summaryInput = input; return 'Project Atlas was discussed.'; },
  });

  const context = await service.getContext({
    userPhone: '919999999922',
    sessionId: '22222222-2222-4222-8222-222222222222',
    provider: 'codex',
  });

  assert.match(context, /CANONICAL CROSS-PROVIDER CONVERSATION SUMMARY/);
  assert.match(context, /Project Atlas was discussed/);
  assert.equal(summaryInput.messages.length, 14);
  const upsert = db.calls.find((call) => /INSERT INTO ari_agent_conversation_summaries/i.test(call.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[1], '919999999922');
  assert.equal(upsert.params[2], '22222222-2222-4222-8222-222222222222');
  assert.equal(upsert.params[5], 'codex');
});

test('a current durable summary is reused without another model call', async () => {
  const db = fakeDatabase({
    count: 20,
    maxId: 20,
    existing: {
      summary: 'Current durable summary.',
      source_message_count: 20,
      source_last_history_id: 20,
    },
  });
  let summarized = 0;
  const service = createAgentConversationSummaryService({
    queryFn: db.queryFn,
    summarize: async () => { summarized++; return 'new'; },
  });

  const context = await service.getContext({ userPhone: '919999999923', sessionId: null });

  assert.match(context, /Current durable summary/);
  assert.equal(summarized, 0);
  assert.equal(db.calls.some((call) => /SELECT id, role, content/i.test(call.sql)), false);
});

test('summary queries remain scoped to the exact tenant and dashboard session', async () => {
  const db = fakeDatabase({ count: 0 });
  const service = createAgentConversationSummaryService({ queryFn: db.queryFn });
  const sessionId = '33333333-3333-4333-8333-333333333333';

  await service.getContext({ userPhone: '919999999924', sessionId });

  const stats = db.calls.find((call) => /COUNT\(\*\).*conversation_history/is.test(call.sql));
  assert.deepEqual(stats.params, ['919999999924', sessionId]);
  assert.match(stats.sql, /session_id = \$2::uuid/);
});
