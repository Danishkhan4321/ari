'use strict';

// The agent loop is the default brain (Jul 2026): _shouldUseAgentLoop is ON
// unless the AGENTIC_MODE_ALL=false kill switch reverts to single-shot, and
// pending tool-level clarifications intercept BEFORE the loop on both paths.

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const controller = require('../src/controllers/webhook.controller');

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('agent loop is ON by default for every user', () => {
  withEnv({ AGENTIC_MODE_ALL: undefined, AGENTIC_MODE_PHONES: undefined }, () => {
    assert.equal(controller._shouldUseAgentLoop('919000000001'), true);
  });
});

test('AGENTIC_MODE_ALL=false is a kill switch back to single-shot', () => {
  withEnv({ AGENTIC_MODE_ALL: 'false', AGENTIC_MODE_PHONES: undefined }, () => {
    assert.equal(controller._shouldUseAgentLoop('919000000001'), false);
  });
});

test('kill switch tolerates common falsy spellings and whitespace', () => {
  for (const value of ['0', 'off', 'no', ' false ', 'FALSE']) {
    withEnv({ AGENTIC_MODE_ALL: value, AGENTIC_MODE_PHONES: undefined }, () => {
      assert.equal(controller._shouldUseAgentLoop('919000000001'), false, `value: "${value}"`);
    });
  }
});

test('chained-request detection joins commands, not nouns', () => {
  const { isLikelyChainedRequest } = require('../src/services/agent-loop.service');
  // Commands joined — must run the full loop.
  assert.equal(isLikelyChainedRequest('create the group and add Priya to it'), true);
  assert.equal(isLikelyChainedRequest('find my overdue tasks then remind me about each'), true);
  assert.equal(isLikelyChainedRequest('email John and then schedule a call'), true);
  // Nouns joined — single tool, short-circuit must stay available.
  assert.equal(isLikelyChainedRequest('remind me tomorrow at 9 to buy bread and milk'), false);
  assert.equal(isLikelyChainedRequest('save Priya and Rahul as contacts'), false);
  assert.equal(isLikelyChainedRequest('what meetings do I have with sales and marketing'), false);
});

test('with the kill switch on, AGENTIC_MODE_PHONES re-enables specific users', () => {
  withEnv({ AGENTIC_MODE_ALL: 'false', AGENTIC_MODE_PHONES: '919000000001, 919000000002' }, () => {
    assert.equal(controller._shouldUseAgentLoop('919000000001'), true);
    assert.equal(controller._shouldUseAgentLoop('919000000009'), false);
  });
});

test('pending clarification consumes the answer and re-executes the original tool', async () => {
  const phone = '917777777001';
  controller.pendingClarificationContext.set(phone, {
    tool: 'task_assign',
    action: 'assign',
    awaitingField: 'task_title',
    params: { assignee: 'Priya' },
  });
  const original = controller.executeIntent;
  let received = null;
  controller.executeIntent = async (type, params) => {
    received = { type, params };
    return 'Task assigned.';
  };
  try {
    const reply = await controller._tryPendingClarification({ from: phone, text: 'review the deck' }, {});
    assert.equal(reply, 'Task assigned.');
    assert.equal(received.type, 'task_assign');
    assert.equal(received.params.task_title, 'review the deck');
    assert.equal(received.params.assignee, 'Priya');
    assert.equal(controller.pendingClarificationContext.get(phone), undefined, 'pending entry consumed');
  } finally {
    controller.executeIntent = original;
  }
});

test('cancel keywords clear the pending clarification', async () => {
  const phone = '917777777002';
  controller.pendingClarificationContext.set(phone, {
    tool: 'task_assign', action: 'assign', awaitingField: 'task_title', params: {},
  });
  const reply = await controller._tryPendingClarification({ from: phone, text: 'nevermind' }, {});
  assert.match(reply, /cancelled/i);
  assert.equal(controller.pendingClarificationContext.get(phone), undefined);
});

test('no pending clarification returns undefined so normal routing continues', async () => {
  const reply = await controller._tryPendingClarification({ from: '917777777003', text: 'hello' }, {});
  assert.equal(reply, undefined);
});
