'use strict';

// Campaign write path. The contract that matters most: create_draft stages a
// campaign WITHOUT sending, and start is the only action that sends — gated by
// confirmation because it emails every member of a group.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAgentToolArguments,
  effectForArgs,
  confirmationModeForTool,
  getAgentToolContract,
} = require('../src/services/agent-tool-contracts.service');
const { compileForMember, DRAFT_STATUS } = require('../src/services/campaign.service');
const { inferredDomains } = require('../src/services/agent-tool-selector.service');

test('a draft is staged in the pending state, which never sends', () => {
  assert.equal(DRAFT_STATUS, 'pending');
});

test('campaign actions carry the right effect and confirmation', () => {
  const cases = [
    ['list', {}, 'read', 'none'],
    ['status', { campaign_id: 1 }, 'read', 'none'],
    ['compose', { purpose: 'introduce the launch' }, 'reversible_write', 'none'],
    ['create_draft', { group_name: 'Leads' }, 'reversible_write', 'none'],
    ['update', { campaign_id: 1, subject: 'New' }, 'reversible_write', 'none'],
    ['pause', { campaign_id: 1 }, 'reversible_write', 'none'],
    ['archive', { campaign_id: 1 }, 'reversible_write', 'none'],
    // Sending real email to a whole group must be external + confirmed.
    ['start', { campaign_id: 1 }, 'external_write', 'central'],
    ['delete', { campaign_id: 1 }, 'destructive', 'central'],
  ];
  for (const [action, extra, effect, confirmation] of cases) {
    const validation = validateAgentToolArguments('manage_campaigns', { action, ...extra });
    assert.ok(validation.success, `${action} should validate: ${validation.success ? '' : validation.error.message}`);
    assert.equal(effectForArgs('manage_campaigns', validation.data), effect, `${action} effect`);
    assert.equal(confirmationModeForTool('manage_campaigns', validation.data), confirmation, `${action} confirmation`);
  }
});

test('destructive and sending actions require an explicit campaign selector', () => {
  for (const action of ['start', 'pause', 'archive', 'delete']) {
    const validation = validateAgentToolArguments('manage_campaigns', { action });
    assert.equal(validation.success, false, `${action} must not run without a campaign_id`);
  }
  assert.equal(validateAgentToolArguments('manage_campaigns', { action: 'create_draft' }).success, false,
    'create_draft needs an audience group');
  assert.equal(validateAgentToolArguments('manage_campaigns', { action: 'compose' }).success, false,
    'compose needs a purpose');
});

test('the tool advertises its write actions', () => {
  const contract = getAgentToolContract('manage_campaigns');
  const actions = contract.inputSchema.properties.action.enum;
  for (const action of ['create_draft', 'compose', 'start', 'pause', 'archive', 'delete']) {
    assert.ok(actions.includes(action), `${action} must be offered`);
  }
  assert.ok(!/read-only/i.test(contract.description), 'the description must not still claim read-only');
});

test('placeholders compile per recipient the way the dashboard composer does', () => {
  const template = 'Hi {first_name}, I saw {company} is hiring. — sent to {name}';
  assert.equal(
    compileForMember(template, { name: 'Priya Sharma', company: 'Acme' }),
    'Hi Priya, I saw Acme is hiring. — sent to Priya Sharma',
  );
  // Missing fields must not leave raw placeholders in a real email.
  assert.equal(compileForMember('Hi {first_name} from {company}', { name: 'Rahul' }), 'Hi Rahul from ');
});

test('campaign wording routes to the sales tool domain', () => {
  for (const phrase of ['create a campaign', 'pause the campaign', 'what campaigns are running']) {
    assert.deepEqual(inferredDomains(phrase), ['sales'], phrase);
  }
});
