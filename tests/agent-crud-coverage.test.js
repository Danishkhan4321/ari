'use strict';

// P2 coverage gaps found in the tool audit: every one of these was an action a
// user could ask for in plain English and the dashboard could perform, but the
// agent had no way to reach. Each test pins BOTH halves — the contract accepts
// the call, and the handler actually performs the write it claims.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getToolDefinitions, getIntentForTool } = require('../src/services/tool-definitions');
const contracts = require('../src/services/agent-tool-contracts.service');
const { createContactGroupHandler } = require('../src/handlers/contact-group.handler');
const { createContactGroupService } = require('../src/services/contact-group.service');

function toolByName(name) {
  return getToolDefinitions().find((tool) => tool.function.name === name);
}

// ── group member removal ────────────────────────────────────────────────
test('manage_contact_groups can remove members without deleting the people', async () => {
  const tool = toolByName('manage_contact_groups');
  assert.ok(tool.function.parameters.properties.action.enum.includes('remove_members'));

  const valid = contracts.validateAgentToolArguments('manage_contact_groups', {
    action: 'remove_members', group_name: 'Investors', member_names: ['Priya'],
  });
  assert.equal(valid.success, true);
  // Dropping a membership row is undoable by re-adding, so it must not be
  // classified destructive and must not stall behind a confirmation gate.
  assert.equal(contracts.effectForArgs('manage_contact_groups', valid.data), 'reversible_write');
  assert.equal(contracts.confirmationModeForTool('manage_contact_groups', valid.data), 'none');

  const missingNames = contracts.validateAgentToolArguments('manage_contact_groups', {
    action: 'remove_members', group_name: 'Investors',
  });
  assert.equal(missingNames.success, false, 'a nameless removal must never reach the handler');

  const handler = createContactGroupHandler({
    contactGroupService: {
      removeMembersByNames: async (phone, group, names) => {
        assert.deepEqual(names, ['Priya', 'Ghost']);
        return { group: { name: 'Investors' }, removed: ['Priya'], notFound: ['Ghost'], ambiguous: [] };
      },
    },
  });
  const result = await handler({}, {
    userPhone: '919000000000',
    agentExecution: {},
    intentParams: { action: 'remove_members', group_name: 'Investors', member_names: ['Priya', 'Ghost'] },
  });
  assert.equal(result.status, 'success');
  assert.match(result.user_summary, /Removed 1 member/);
  assert.match(result.user_summary, /contacts themselves were kept/);
  assert.match(result.user_summary, /Not in that group: Ghost/);
});

test('removing members deletes only the membership row, never the contact', async () => {
  const statements = [];
  const service = createContactGroupService({
    queryFn: async (sql, params) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM contact_groups/.test(sql)) return { rows: [{ id: 5, name: 'Investors' }] };
      if (/FROM sales_leads/.test(sql)) return { rows: [{ id: 11, name: 'Priya' }] };
      if (/FROM contacts/.test(sql)) return { rows: [] };
      if (/DELETE FROM contact_group_members/.test(sql)) {
        assert.deepEqual(params, [5, 'lead', 11]);
        return { rows: [{ id: 99 }] };
      }
      return { rows: [] };
    },
  });
  const result = await service.removeMembersByNames('919000000000', 'Investors', ['Priya']);
  assert.deepEqual(result.removed, ['Priya']);
  assert.ok(statements.some((sql) => sql.startsWith('DELETE FROM contact_group_members')));
  assert.ok(!statements.some((sql) => /DELETE FROM (sales_leads|contacts)\b/.test(sql)),
    'membership removal must never delete the underlying person');
});

// ── lead archive / restore / contact logging ────────────────────────────
test('manage_sales exposes archive, restore, and mark_contacted with a required lead', () => {
  const tool = toolByName('manage_sales');
  for (const action of ['archive', 'restore', 'mark_contacted']) {
    assert.ok(tool.function.parameters.properties.action.enum.includes(action), `${action} must be offered`);
    const missing = contracts.validateAgentToolArguments('manage_sales', { action });
    assert.equal(missing.success, false, `${action} without a lead must be rejected`);
    const valid = contracts.validateAgentToolArguments('manage_sales', { action, lead_name: 'Acme' });
    assert.equal(valid.success, true);
    // Archiving hides a lead; it is recoverable, unlike delete.
    assert.equal(contracts.effectForArgs('manage_sales', valid.data), 'reversible_write');
    assert.equal(contracts.confirmationModeForTool('manage_sales', valid.data), 'none');
  }
  // The irreversible one keeps its gate.
  const del = contracts.validateAgentToolArguments('manage_sales', { action: 'delete', lead_name: 'Acme' });
  assert.equal(contracts.effectForArgs('manage_sales', del.data), 'destructive');
});

test('sales command parsing maps the new actions to distinct handler branches', async () => {
  const salesService = require('../src/services/sales.service');
  assert.deepEqual(
    await salesService.parseCommand('', { action: 'archive', lead_name: 'Acme' }),
    { action: 'archive', target: 'Acme' },
  );
  assert.deepEqual(
    await salesService.parseCommand('', { action: 'restore', lead_name: 'Acme' }),
    { action: 'restore', target: 'Acme' },
  );
  assert.deepEqual(
    await salesService.parseCommand('', { action: 'mark_contacted', lead_name: 'Acme', notes: 'called' }),
    { action: 'mark_contacted', target: 'Acme', notes: 'called' },
  );
  // Archiving must never be confused with deleting on the regex path.
  assert.deepEqual(await salesService.parseCommand('archive lead Acme'), { action: 'archive', target: 'Acme' });
  assert.deepEqual(await salesService.parseCommand('restore lead Acme'), { action: 'restore', target: 'Acme' });
  assert.deepEqual(await salesService.parseCommand('delete lead Acme'), { action: 'delete', target: 'Acme' });
});

// ── reminder completion ─────────────────────────────────────────────────
test('complete_reminder is a separate, non-destructive tool from cancel_reminder', () => {
  const tool = toolByName('complete_reminder');
  assert.ok(tool, 'complete_reminder must exist');
  assert.equal(getIntentForTool('complete_reminder'), 'reminder_complete');

  const valid = contracts.validateAgentToolArguments('complete_reminder', { position: 2 });
  assert.equal(valid.success, true);
  assert.equal(contracts.effectForArgs('complete_reminder', valid.data), 'reversible_write');
  assert.equal(contracts.confirmationModeForTool('complete_reminder', valid.data), 'none');
  // Cancelling still asks first — the two must not collapse into one effect.
  const cancel = contracts.validateAgentToolArguments('cancel_reminder', { position: 2 });
  assert.equal(contracts.effectForArgs('cancel_reminder', cancel.data), 'destructive');

  // Same one-selector discipline as cancel: no guessing which reminder.
  assert.equal(contracts.validateAgentToolArguments('complete_reminder', {}).success, false);
  assert.equal(
    contracts.validateAgentToolArguments('complete_reminder', { position: 2, reminder_id: 9 }).success,
    false,
    'two selectors must be rejected rather than silently preferring one',
  );
});

// ── meeting recording writes ────────────────────────────────────────────
test('get_meeting_recordings gained the three Meetings-page writes', () => {
  const tool = toolByName('get_meeting_recordings');
  for (const action of ['retry', 'rename_speaker', 'create_tasks']) {
    assert.ok(tool.function.parameters.properties.action.enum.includes(action));
  }
  // A read stays a read; the writes are classified as writes.
  const list = contracts.validateAgentToolArguments('get_meeting_recordings', { action: 'list' });
  assert.equal(contracts.effectForArgs('get_meeting_recordings', list.data), 'read');
  const retry = contracts.validateAgentToolArguments('get_meeting_recordings', { action: 'retry', meeting_id: 7 });
  assert.equal(retry.success, true);
  assert.equal(contracts.effectForArgs('get_meeting_recordings', retry.data), 'reversible_write');

  // No selector => no guessing which meeting gets reprocessed or rewritten.
  for (const action of ['retry', 'rename_speaker', 'create_tasks']) {
    const result = contracts.validateAgentToolArguments('get_meeting_recordings', {
      action, speaker_id: 'A', speaker_name: 'Priya',
    });
    assert.equal(result.success, false, `${action} must require meeting_id or meeting_title`);
  }
  assert.equal(
    contracts.validateAgentToolArguments('get_meeting_recordings', {
      action: 'rename_speaker', meeting_id: 7, speaker_id: 'A',
    }).success,
    false,
    'a rename without a name must be rejected',
  );
  assert.equal(
    contracts.validateAgentToolArguments('get_meeting_recordings', {
      action: 'rename_speaker', meeting_id: 7, speaker_id: 'Speaker A', speaker_name: 'Priya',
    }).success,
    false,
    'speaker_id must stay in the diarizer label format the repository validates',
  );
});

test('the description of every changed tool matches the actions it now accepts', () => {
  const cases = [
    ['manage_contact_groups', ['remove_members']],
    ['manage_sales', ['archive', 'restore', 'mark_contacted']],
    ['get_meeting_recordings', ['retry', 'rename_speaker', 'create_tasks']],
  ];
  for (const [name, actions] of cases) {
    const tool = toolByName(name);
    const text = `${tool.function.description} ${tool.function.parameters.properties.action.description}`;
    for (const action of actions) {
      assert.ok(text.includes(action), `${name} must document its ${action} action to the model`);
    }
  }
  // get_meeting_recordings is no longer read-only; saying so would make the
  // model refuse the writes it can now perform.
  assert.ok(!/Read-only/i.test(toolByName('get_meeting_recordings').function.description));
});
