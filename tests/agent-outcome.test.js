'use strict';

// Status fencing: tool results are the source of truth, and the reply must
// never claim an action that did not happen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { finalizeAgentOutcome } = require('../src/services/agent-outcome.service');
const { normalizeToolResult } = require('../src/services/tool-result.service');

const ok = (tool, summary) => normalizeToolResult(
  { status: 'success', user_summary: summary, data: {} }, { toolName: tool },
);
const failed = (tool, message, summary = '') => normalizeToolResult({
  status: 'failure',
  user_summary: summary,
  error: { code: 'tool_execution_error', category: 'execution', retryable: false, message },
}, { toolName: tool });

test('a failed tool alongside a success yields partial, never completed', () => {
  // The live regression: manage_contact_groups succeeded, but
  // handle_email_confirmation failed, and the model still narrated success —
  // the run was logged "completed" and the user was told the email was edited.
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    // Verbatim shape of the observed reply: it narrated the real sync, then
    // claimed an email edit whose tool had actually failed.
    modelText: 'Synchronized all 15 CRM groups and 2939 unique people.\n\nI\'ve added "hii" to the email. Should I send it?',
    toolResults: [
      ok('manage_contact_groups', 'Synchronized all 15 CRM groups.'),
      failed('handle_email_confirmation', 'returned no result; completion was not verified'),
    ],
    terminalToolResult: null,
    toolsUsedCount: 2,
  });

  assert.equal(outcome.status, 'partial', 'a failed action must not be reported as completed');
  assert.match(outcome.text, /Synchronized all 15 CRM groups/, 'the genuine success is preserved');
  assert.match(outcome.text, /handle email confirmation/i, 'the failure must be surfaced to the user');
});

test('all tools failing yields failed', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Done!',
    toolResults: [failed('send_email', 'smtp refused')],
    terminalToolResult: null,
    toolsUsedCount: 1,
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.text, /send email/i);
});

test('a tool that failed then succeeded on retry is recovered, not partial', () => {
  // The model correcting invalid arguments must not permanently mark the run
  // partial — only the final attempt per tool counts.
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Added the task.',
    toolResults: [
      failed('manage_tasks', 'invalid arguments'),
      ok('manage_tasks', 'Task added: "review the deck".'),
    ],
    terminalToolResult: null,
    toolsUsedCount: 2,
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Added the task.', 'no failure noise after a clean recovery');
});

test('an all-success run is untouched', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Both done.',
    toolResults: [ok('manage_tasks', 'Task added.'), ok('set_reminder', 'Reminder set.')],
    terminalToolResult: null,
    toolsUsedCount: 2,
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Both done.');
});

test('model prose claiming failure after all-success is replaced by verified summaries', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'I could not complete that.',
    toolResults: [ok('manage_tasks', 'Task added: "ship it".')],
    terminalToolResult: null,
    toolsUsedCount: 1,
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Task added: "ship it".');
});

test('a pending approval still fences to the approval prompt', () => {
  const pending = normalizeToolResult({
    status: 'waiting_approval', user_summary: 'Send this email? Reply yes.', data: { pending: true },
  }, { toolName: 'send_email' });
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'I sent the email.',
    toolResults: [pending],
    terminalToolResult: pending,
    toolsUsedCount: 1,
  });
  assert.equal(outcome.status, 'waiting_approval');
  assert.equal(outcome.text, 'Send this email? Reply yes.', 'a false send claim must never survive');
});

test('an unknown outcome is partial and keeps its honest wording', () => {
  const unknown = normalizeToolResult({
    status: 'failure',
    user_summary: 'manage_sales stopped without a confirmed outcome; I will not replay it.',
    error: { code: 'tool_aborted_unknown_outcome', category: 'unknown_outcome', retryable: false, message: 'aborted' },
  }, { toolName: 'manage_sales' });
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Moved the lead to proposal.',
    toolResults: [unknown],
    terminalToolResult: unknown,
    toolsUsedCount: 1,
  });
  assert.equal(outcome.status, 'partial');
  assert.match(outcome.text, /without a confirmed outcome/);
});

test('a failure with its own summary uses that wording rather than a generic line', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'All set.',
    toolResults: [
      ok('manage_tasks', 'Task added.'),
      failed('manage_campaigns', 'not supported', 'I cannot create a campaign with the available tools.'),
    ],
    terminalToolResult: null,
    toolsUsedCount: 2,
  });
  assert.equal(outcome.status, 'partial');
  assert.match(outcome.text, /I cannot create a campaign with the available tools\./);
});

// ── narrated-but-never-executed ─────────────────────────────────────────
// Found by the e2e feature journey: after several successful turns the model
// answered "Onboarding started for E2E Priya" having executed ZERO tools. The
// run was recorded completed and the user was told the work landed.
// Nothing in Ari mutates without a tool call, so this is false by construction.
test('a completion claim with zero tools executed is refused, not relayed', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Onboarding started for *E2E Priya* on the *e2e-design* team.',
    toolResults: [],
    terminalToolResult: null,
    toolsUsedCount: 0,
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.text, /did not actually run/i);
  assert.doesNotMatch(outcome.text, /Onboarding started/i);
});

test('the guard does not fire on reads, offers, or questions', () => {
  const harmless = [
    'You have 3 reminders today.',
    'I can add that to your list — shall I?',
    'Which group should receive this campaign?',
    'Here are your contact groups: investors, backers.',
  ];
  for (const modelText of harmless) {
    const outcome = finalizeAgentOutcome({
      modelStatus: 'completed', modelText, toolResults: [], terminalToolResult: null, toolsUsedCount: 0,
    });
    assert.equal(outcome.status, 'completed', `wrongly fenced: ${modelText}`);
    assert.equal(outcome.text, modelText);
  }
});

test('the same claim stands when a tool actually ran', () => {
  const outcome = finalizeAgentOutcome({
    modelStatus: 'completed',
    modelText: 'Onboarding started for Priya.',
    toolResults: [{ status: 'success', tool: 'manage_team_comms', user_summary: 'Started onboarding.' }],
    terminalToolResult: null,
    toolsUsedCount: 1,
  });
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.text, /Onboarding started/i);
});
