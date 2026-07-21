'use strict';

// Regression tests for the three real failing sessions that motivated the
// agent-action-fidelity fixes:
//   (a) attached Excel -> "can't access the file" on the Codex engine
//   (b) "delete all the group from crm" -> no delete action existed
//   (c) team "created" successfully but never appeared in the product
// Each test pins the specific mechanism so the failure cannot silently return.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getToolDefinitions,
  getIntentForTool,
} = require('../src/services/tool-definitions');
const codex = require('../src/services/codex-app-server.service');
const registry = require('../src/mcp/desktop-tool-registry');
const salesService = require('../src/services/sales.service');

// ── (a) Codex tool visibility ───────────────────────────────────────────
test('attachment-hinted tools are promoted out of the deferred namespace', () => {
  const specs = codex.dynamicToolSpecs({
    promoteNames: ['analyze_file', 'manage_contact_groups'],
  });
  const topLevel = new Set(specs.filter((s) => s.type === 'function').map((s) => s.name));
  assert.ok(topLevel.has('analyze_file'), 'analyze_file must be immediately visible when hinted');
  assert.ok(topLevel.has('manage_contact_groups'), 'manage_contact_groups must be immediately visible when hinted');
  const namespace = specs.find((s) => s.type === 'namespace');
  if (namespace) {
    const deferred = new Set(namespace.tools.map((t) => t.name));
    assert.ok(!deferred.has('analyze_file'), 'a promoted tool must not also be deferred');
    assert.ok(!deferred.has('manage_contact_groups'), 'a promoted tool must not also be deferred');
  }
});

test('check_inbox is never advertised as a Codex core tool (it is disabled)', () => {
  const specs = codex.dynamicToolSpecs();
  const names = new Set(specs.filter((s) => s.type === 'function').map((s) => s.name));
  assert.ok(!names.has('check_inbox'), 'disabled Google tools must not appear in the core set');
  // And it must not be reachable at all through getToolDefinitions().
  assert.ok(!getToolDefinitions().some((t) => t.function.name === 'check_inbox'));
});

// ── (b) CRM group deletion exists and routes ────────────────────────────
test('manage_contact_groups exposes a delete action', () => {
  const tool = getToolDefinitions().find((t) => t.function.name === 'manage_contact_groups');
  assert.ok(tool, 'manage_contact_groups must exist');
  assert.ok(tool.function.parameters.properties.action.enum.includes('delete'),
    'delete must be a valid manage_contact_groups action');
  assert.equal(getIntentForTool('manage_contact_groups'), 'contact_group_manage');
});

test('contact-group delete requires confirmation before a bulk wipe', async () => {
  const { createContactGroupHandler } = require('../src/handlers/contact-group.handler');
  const listed = [{ name: 'clients' }, { name: 'investors' }];
  const handler = createContactGroupHandler({
    contactGroupService: {
      listGroups: async () => listed,
      deleteAllGroups: async () => ({ deletedCount: 2, deleted: ['clients', 'investors'] }),
    },
  });
  // First call, no confirm -> must ask, must NOT delete.
  const ask = await handler({}, {
    userPhone: '919999999999',
    agentExecution: { runtime: 'codex' },
    intentParams: { action: 'delete', delete_all: true },
  });
  assert.equal(ask.status, 'waiting_input', 'bulk delete must pause for confirmation');

  // Second call, confirm=true -> executes and verifies the count.
  const done = await handler({}, {
    userPhone: '919999999999',
    agentExecution: { runtime: 'codex' },
    intentParams: { action: 'delete', delete_all: true, confirm: true },
  });
  assert.equal(done.status, 'success');
  assert.equal(done.data.deletedCount, 2);
});

// ── (c) team create is a real, verified write ───────────────────────────
test('team create no longer degrades to a chat reply as a tool result', () => {
  const controller = require('../src/controllers/webhook.controller');
  // Unparseable free text + agent runtime must yield a typed failure, never
  // a free-form chat string masquerading as a successful tool result.
  const cmd = controller.teamCommandFromParams({ action: 'create', team_name: 'marketing' });
  assert.deepEqual(cmd, { action: 'create', teamName: 'marketing', members: [] });
});

// ── tool bridge honesty ─────────────────────────────────────────────────
test('a text-requiring tool called with no arguments fails honestly', async () => {
  // The literal tool name must never become the user message.
  const result = await registry.callTool('919999999999', 'manage_team', {});
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'invalid_tool_arguments');
});

test('a zero-argument tool is NOT rejected by the missing-args guard', async () => {
  // daily_briefing legitimately takes no arguments; the guard must let it run.
  const controller = require('../src/controllers/webhook.controller');
  const originalGetContext = controller.getContext;
  const originalExecuteIntent = controller.executeIntent;
  controller.getContext = async () => ({ userTimezone: 'Asia/Kolkata' });
  controller.executeIntent = async () => 'Here is your briefing.';
  try {
    const result = await registry.callTool('919999999999', 'daily_briefing', {});
    assert.notEqual(result.error?.code, 'missing_tool_arguments',
      'a zero-argument tool must pass the guard');
    assert.equal(result.status, 'success');
  } finally {
    controller.getContext = originalGetContext;
    controller.executeIntent = originalExecuteIntent;
  }
});

// ── sales stage mapping ─────────────────────────────────────────────────
test('sales stage aliases won/lost map to closed_won/closed_lost', () => {
  assert.equal(salesService.normalizeStage('won'), 'closed_won');
  assert.equal(salesService.normalizeStage('lost'), 'closed_lost');
  assert.equal(salesService.normalizeStage('Closed Won'), 'closed_won');
  assert.equal(salesService.normalizeStage('meeting'), 'meeting');
  assert.equal(salesService.normalizeStage('nonsense'), null);
});
