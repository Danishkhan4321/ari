'use strict';

// P3: the dashboard Team pages (broadcasts, 1:1s, onboarding, member details,
// invite link, chat) were entirely unreachable from chat. These tests pin the
// contract, the admin scoping, and the fact that a chat-originated broadcast is
// now recorded exactly like a dashboard one.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getToolDefinitions, getIntentForTool } = require('../src/services/tool-definitions');
const contracts = require('../src/services/agent-tool-contracts.service');
const { createTeamCommsHandler } = require('../src/handlers/team-comms.handler');
const { createTeamWorkspaceService } = require('../src/services/team-workspace.service');

const ADMIN = { adminPhone: '919000000000', teamName: 'design', isAdmin: true };
const MEMBER_VIEW = { adminPhone: '918888888888', teamName: 'design', isAdmin: false };

function handlerWith(overrides) {
  return createTeamCommsHandler({
    teamWorkspaceService: {
      resolveTeam: async () => ADMIN,
      resolveMember: async (_admin, name) => ({ member_phone: '919111111111', member_name: name }),
      ...overrides,
    },
  });
}

test('manage_team_comms exposes the whole Team-page surface with typed selectors', () => {
  const tool = getToolDefinitions().find((t) => t.function.name === 'manage_team_comms');
  assert.ok(tool, 'manage_team_comms must exist');
  assert.equal(getIntentForTool('manage_team_comms'), 'team_comms');
  const actions = tool.function.parameters.properties.action.enum;
  for (const action of ['list_broadcasts', 'broadcast_status', 'list_one_on_ones',
    'schedule_one_on_one', 'cancel_one_on_one', 'list_onboardings', 'start_onboarding',
    'complete_onboarding', 'member_info', 'set_member_info', 'invite_link',
    'list_chats', 'send_chat_message']) {
    assert.ok(actions.includes(action), `${action} must be offered`);
  }
  // Sending a NEW broadcast stays on the confirmed delegate_message path;
  // advertising a second send route here would bypass that gate.
  assert.ok(!actions.includes('send_broadcast'));
  assert.match(tool.function.description, /delegate_message/);
});

test('reads are reads, and posting into a team chat is treated as messaging people', () => {
  const readOnly = ['list_broadcasts', 'broadcast_status', 'list_one_on_ones',
    'list_onboardings', 'member_info', 'list_chats'];
  for (const action of readOnly) {
    const args = contracts.validateAgentToolArguments('manage_team_comms', { action });
    assert.equal(args.success, true);
    assert.equal(contracts.effectForArgs('manage_team_comms', args.data), 'read', `${action} must be a read`);
  }
  const post = contracts.validateAgentToolArguments('manage_team_comms', {
    action: 'send_chat_message', chat_name: 'design', message: 'standup at 10',
  });
  assert.equal(post.success, true);
  assert.equal(contracts.effectForArgs('manage_team_comms', post.data), 'external_write');
  assert.equal(contracts.confirmationModeForTool('manage_team_comms', post.data), 'central',
    'posting to the team must be confirmed before it happens');
});

test('every write action names what it needs instead of guessing', () => {
  const required = [
    [{ action: 'schedule_one_on_one', member_name: 'Rahul' }, /due_time/],
    [{ action: 'cancel_one_on_one' }, /one_on_one_id/],
    [{ action: 'start_onboarding' }, /member_name/],
    [{ action: 'complete_onboarding' }, /onboarding_id/],
    [{ action: 'set_member_info', birthday: '1996-03-12' }, /member_name/],
    [{ action: 'send_chat_message', chat_name: 'design' }, /message/],
  ];
  for (const [args, expected] of required) {
    const result = contracts.validateAgentToolArguments('manage_team_comms', args);
    assert.equal(result.success, false, `${args.action} must be rejected`);
    assert.match(String(result.error), expected);
  }
  // A half-remembered birthday must not be written as a date.
  assert.equal(
    contracts.validateAgentToolArguments('manage_team_comms', {
      action: 'set_member_info', member_name: 'Rahul', birthday: 'next tuesday',
    }).success,
    false,
  );
});

test('a non-admin can read the team but cannot change it', async () => {
  const handler = createTeamCommsHandler({
    teamWorkspaceService: {
      resolveTeam: async () => MEMBER_VIEW,
      listOneOnOnes: async () => [],
      startOnboarding: async () => { throw new Error('must not be called'); },
    },
  });
  const read = await handler({ from: '919111111111' }, {
    userPhone: '919111111111', agentExecution: {}, intentParams: { action: 'list_one_on_ones' },
  });
  assert.equal(read.status, 'success');

  const write = await handler({ from: '919111111111' }, {
    userPhone: '919111111111', agentExecution: {}, intentParams: { action: 'start_onboarding', member_name: 'Priya' },
  });
  assert.equal(write.status, 'failure');
  assert.equal(write.error.code, 'team_admin_only');
});

test('an ambiguous team asks which one instead of picking the first', async () => {
  const handler = createTeamCommsHandler({
    teamWorkspaceService: { resolveTeam: async () => ({ ambiguous: true, teams: ['design', 'sales'] }) },
  });
  const result = await handler({ from: '919000000000' }, {
    userPhone: '919000000000', agentExecution: {}, intentParams: { action: 'list_broadcasts' },
  });
  assert.equal(result.status, 'waiting_input');
  assert.match(result.user_summary, /design, sales/);
});

test('a 1:1 is scheduled against resolved members and a parsed time', async () => {
  let captured = null;
  const handler = handlerWith({
    scheduleOneOnOne: async (adminPhone, data) => {
      captured = { adminPhone, data };
      return { oneOnOne: { id: 4, report_name: data.reportName, next_at: data.nextAt, cadence_days: data.cadenceDays } };
    },
  });
  const result = await handler({ from: ADMIN.adminPhone }, {
    userPhone: ADMIN.adminPhone,
    userTimezone: 'Asia/Kolkata',
    agentExecution: {},
    intentParams: { action: 'schedule_one_on_one', member_name: 'Rahul', due_time: '2026-08-03T10:30:00+05:30', cadence_days: 14 },
  });
  assert.equal(result.status, 'success');
  assert.equal(captured.adminPhone, ADMIN.adminPhone);
  assert.equal(captured.data.reportName, 'Rahul');
  assert.equal(captured.data.cadenceDays, 14);
  assert.ok(captured.data.nextAt instanceof Date, 'the phrase must be parsed to a real instant');
  assert.match(result.user_summary, /Rahul/);
});

test('an unknown member is refused by name rather than invented', async () => {
  const handler = handlerWith({ resolveMember: async () => null });
  const result = await handler({ from: ADMIN.adminPhone }, {
    userPhone: ADMIN.adminPhone, agentExecution: {},
    intentParams: { action: 'start_onboarding', member_name: 'Nobody' },
  });
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'team_member_not_found');

  const ambiguous = handlerWith({ resolveMember: async () => ({ ambiguous: true, name: 'Priya' }) });
  const second = await ambiguous({ from: ADMIN.adminPhone }, {
    userPhone: ADMIN.adminPhone, agentExecution: {},
    intentParams: { action: 'start_onboarding', member_name: 'Priya' },
  });
  assert.equal(second.status, 'failure');
  assert.match(second.user_summary, /More than one member/);
});

test('a partial member-detail update never blanks the fields it was not given', async () => {
  const statements = [];
  const service = createTeamWorkspaceService({
    queryFn: async (sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [{ member_phone: '919111111111', birthday: '1996-03-12' }] };
    },
  });
  await service.upsertMemberMeta(ADMIN.adminPhone, 'design', '919111111111', { birthday: '1996-03-12' });
  const upsert = statements.find((s) => s.sql.startsWith('INSERT INTO team_member_meta'));
  assert.ok(upsert, 'the upsert must run');
  assert.match(upsert.sql, /joined_at = COALESCE\(EXCLUDED\.joined_at, team_member_meta\.joined_at\)/);
  assert.match(upsert.sql, /notes = COALESCE\(EXCLUDED\.notes, team_member_meta\.notes\)/);

  // Nothing at all to save is a question, not an empty write.
  const empty = await service.upsertMemberMeta(ADMIN.adminPhone, 'design', '919111111111', {});
  assert.ok(empty.error);
});

test('a chat message only posts to a thread the sender belongs to', async () => {
  const service = createTeamWorkspaceService({
    queryFn: async (sql) => {
      if (/FROM team_chats c\s+JOIN team_chat_members/.test(sql.replace(/\s+/g, ' '))) return { rows: [] };
      return { rows: [{ id: 1 }] };
    },
  });
  const denied = await service.sendChatMessage(ADMIN.adminPhone, '919111111111', { chatName: 'secret', text: 'hi' });
  assert.ok(denied.error, 'a non-member must not be able to post');
  assert.equal(
    (await service.sendChatMessage(ADMIN.adminPhone, '919111111111', { chatName: 'design', text: '   ' })).error !== undefined,
    true,
    'an empty message must be refused before any insert',
  );
});

test('a broadcast sent from chat is recorded like a dashboard one', async () => {
  const teamComms = require('../src/services/team-comms.service');
  const calls = [];
  const original = {
    createTeamMessage: teamComms.createTeamMessage,
    updateRecipientWamid: teamComms.updateRecipientWamid,
    markRecipientSent: teamComms.markRecipientSent,
    markRecipientFailed: teamComms.markRecipientFailed,
  };
  teamComms.createTeamMessage = async (adminPhone, teamName, text, type, members) => {
    calls.push({ kind: 'track', adminPhone, teamName, type, count: members.length });
    return { id: 77 };
  };
  teamComms.updateRecipientWamid = async (id, phone, wamid) => calls.push({ kind: 'wamid', id, phone, wamid });
  teamComms.markRecipientSent = async (id, phone) => calls.push({ kind: 'sent', id, phone });
  teamComms.markRecipientFailed = async (id, phone) => calls.push({ kind: 'failed', id, phone });
  try {
    const result = await teamComms.sendBroadcast({
      adminPhone: ADMIN.adminPhone,
      teamName: 'design',
      messageText: 'standup at 10',
      members: [
        { member_phone: '919111111111', member_name: 'Rahul' },
        { member_phone: '919111111111', member_name: 'Rahul duplicate' },
        { member_phone: '919222222222', member_name: 'Priya' },
      ],
      // The chat path injects its own send so it keeps its timeout guard.
      send: async (phone) => (phone === '919222222222' ? Promise.reject(new Error('offline')) : 'wamid.1'),
    });
    assert.equal(result.total, 2, 'the duplicate recipient must be collapsed');
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.team_message_id, 77);
    assert.deepEqual(result.failed_recipients, [{ name: 'Priya', phone: '919222222222' }]);
    assert.ok(calls.some((c) => c.kind === 'track' && c.type === 'broadcast'),
      'the broadcast must leave a team_messages row so the dashboard can show it');
    assert.ok(calls.some((c) => c.kind === 'wamid' && c.wamid === 'wamid.1'),
      'read receipts need the wamid recorded per recipient');
    assert.ok(calls.some((c) => c.kind === 'failed' && c.phone === '919222222222'));
  } finally {
    Object.assign(teamComms, original);
  }
});
