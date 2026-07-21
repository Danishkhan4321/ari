'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/mcp/desktop-tool-registry');

test('desktop Codex receives the complete Ari action registry as MCP tools', () => {
  const tools = registry.listTools();
  assert.ok(tools.length >= 80);
  assert.ok(tools.some((tool) => tool.name === 'set_reminder'));
  assert.ok(tools.some((tool) => tool.name === 'save_contact'));
  assert.ok(tools.some((tool) => tool.name === 'manage_team'));
  assert.ok(tools.every((tool) => tool.inputSchema?.type === 'object'));
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false));
  for (const tool of tools) {
    for (const [name, property] of Object.entries(tool.inputSchema.properties || {})) {
      assert.ok(property.description, `${tool.name}.${name} needs a description`);
    }
  }
});

test('desktop and primary agent share canonical typed schemas without full_text', () => {
  const tools = registry.listTools();
  const email = tools.find((tool) => tool.name === 'send_email');
  assert.deepEqual(email.inputSchema.required, ['recipients', 'body']);
  assert.ok(email.inputSchema.properties.recipients);
  assert.ok(email.inputSchema.properties.body);
  assert.equal(email.inputSchema.properties.full_text, undefined);

  const calendar = tools.find((tool) => tool.name === 'create_calendar_event');
  assert.deepEqual(calendar.inputSchema.required, ['title', 'start_time']);
  assert.equal(calendar.inputSchema.properties.full_text, undefined);
});

test('desktop tool schemas recursively reject unknown object fields', () => {
  const schema = registry.normalizeInputSchema({
    type: 'object',
    properties: {
      filters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
      rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
    },
  });
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.filters.additionalProperties, false);
  assert.equal(schema.properties.rows.items.additionalProperties, false);
  assert.match(schema.properties.filters.properties.query.description, /query/i);
});

test('unknown desktop tools return a deterministic recovery envelope', async () => {
  const result = await registry.callTool('919999999999', 'does_not_exist', {});
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'unknown_tool');
  assert.ok(Array.isArray(result.next_actions));
  assert.ok(Array.isArray(result.artifacts));
});

test('desktop tool bridge validates typed arguments and adapts them for legacy handlers', async (t) => {
  const webhookController = require('../src/controllers/webhook.controller');
  const timezoneService = require('../src/services/timezone.service');
  const originalGetContext = webhookController.getContext;
  const originalExecuteIntent = webhookController.executeIntent;
  const originalGetTimezone = timezoneService.getUserTimezone;
  let captured = null;

  webhookController.getContext = async () => ({ userTimezone: 'Asia/Kolkata' });
  timezoneService.getUserTimezone = async () => 'Asia/Kolkata';
  webhookController.executeIntent = async (intent, args, message) => {
    captured = { intent, args, message };
    return { status: 'success', user_summary: 'Draft prepared.' };
  };
  t.after(() => {
    webhookController.getContext = originalGetContext;
    webhookController.executeIntent = originalExecuteIntent;
    timezoneService.getUserTimezone = originalGetTimezone;
  });

  const result = await registry.callTool('919999990772', 'send_email', {
    recipients: ['alice@example.com'],
    subject: 'Launch',
    body: 'Please review the plan.',
  }, { originalText: 'email Alice the launch plan' });

  assert.equal(result.status, 'success');
  assert.equal(captured.intent, 'email_send');
  assert.deepEqual(captured.args.recipients, ['alice@example.com']);
  assert.equal(captured.args.full_text, captured.message.text);
  assert.match(captured.message.agentToolCallId, /^desktop:send_email:/,
    'controller handlers must be able to distinguish agent calls from legacy dashboard messages');
  assert.match(captured.message.text, /alice@example\.com/);
  assert.match(captured.message.text, /Please review the plan/);

  const invalid = await registry.callTool('919999990772', 'send_email', {
    recipients: ['alice@example.com'],
    body: 'Hello',
    unsafe_extra: 'must not reach handler',
  });
  assert.equal(invalid.status, 'failure');
  assert.equal(invalid.error.code, 'invalid_tool_arguments');
});

test('desktop tool bridge applies the same central destructive-action gate', async (t) => {
  const webhookController = require('../src/controllers/webhook.controller');
  const timezoneService = require('../src/services/timezone.service');
  const confirmationGate = require('../src/services/confirmation-gate.service');
  const originals = {
    getContext: webhookController.getContext,
    executeIntent: webhookController.executeIntent,
    getTimezone: timezoneService.getUserTimezone,
    pend: confirmationGate.pend,
  };
  t.after(() => {
    webhookController.getContext = originals.getContext;
    webhookController.executeIntent = originals.executeIntent;
    timezoneService.getUserTimezone = originals.getTimezone;
    confirmationGate.pend = originals.pend;
  });

  webhookController.getContext = async () => ({ userTimezone: 'Asia/Kolkata' });
  timezoneService.getUserTimezone = async () => 'Asia/Kolkata';
  let handlerCalls = 0;
  let pending;
  webhookController.executeIntent = async (_intent, _args, _message, context) => {
    handlerCalls++;
    assert.equal(context.agentExecution.confirmedByPolicy, true);
    return 'Reminder cancelled.';
  };
  confirmationGate.pend = async (_user, options) => {
    pending = options;
    return 'Confirm cancellation?';
  };

  const result = await registry.callTool('919999990773', 'cancel_reminder', {
    query: 'visa documents',
  });
  assert.equal(result.status, 'waiting_approval');
  assert.equal(handlerCalls, 0);
  assert.match(result.summary, /confirm cancellation/i);
  assert.match(pending.summary, /query: visa documents/i);
  assert.equal(await pending.execute(), 'Reminder cancelled.');
  assert.equal(handlerCalls, 1);
});

test('desktop tool bridge preserves explicit and newly-created clarification waits', async (t) => {
  const webhookController = require('../src/controllers/webhook.controller');
  const timezoneService = require('../src/services/timezone.service');
  const userPhone = '919999990771';
  const originalGetContext = webhookController.getContext;
  const originalExecuteIntent = webhookController.executeIntent;
  const originalGetTimezone = timezoneService.getUserTimezone;

  webhookController.getContext = async () => ({ userTimezone: 'Asia/Kolkata' });
  timezoneService.getUserTimezone = async () => 'Asia/Kolkata';
  t.after(() => {
    webhookController.getContext = originalGetContext;
    webhookController.executeIntent = originalExecuteIntent;
    timezoneService.getUserTimezone = originalGetTimezone;
    webhookController.pendingClarificationContext.delete(userPhone);
    webhookController.lastClarificationContext.delete(userPhone);
  });

  webhookController.executeIntent = async (intent) => {
    assert.equal(intent, 'clarify');
    return 'Which deal should I update?';
  };
  const explicit = await registry.callTool(userPhone, 'request_clarification', {
    question: 'Which deal should I update?',
  });
  assert.equal(explicit.status, 'waiting_input');
  assert.equal(explicit.summary, 'Which deal should I update?');
  assert.match(explicit.next_actions[0], /wait for the user/i);

  const preexisting = { tool: 'manage_tasks', awaitingField: 'task_title', askedAt: 1 };
  webhookController.pendingClarificationContext.set(userPhone, preexisting);
  webhookController.executeIntent = async () => 'Your dashboard is ready.';
  const unchanged = await registry.callTool(userPhone, 'view_dashboard', { section: 'overview' });
  assert.equal(unchanged.status, 'success', 'an older clarification must not taint this call');

  webhookController.executeIntent = async (_intent, _args, message) => {
    webhookController.pendingClarificationContext.set(message.from, {
      tool: 'manage_tasks',
      awaitingField: 'task_title',
      askedAt: Date.now(),
    });
    return 'What task should I assign?';
  };
  const createdByHandler = await registry.callTool(userPhone, 'manage_tasks', {
    action: 'assign',
    assignee_name: 'Rohan',
  });
  assert.equal(createdByHandler.status, 'waiting_input');
  assert.equal(createdByHandler.summary, 'What task should I assign?');
});
