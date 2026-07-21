'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../src/services/confirmation-gate.service');
const {
  confirmationModeForTool,
  renderConfirmationPreview,
} = require('../src/services/agent-tool-contracts.service');

test('explicit confirmation policy never treats praise or task-status words as approval', () => {
  assert.equal(gate.classifyExplicitReply('yes, send it'), 'confirm');
  assert.equal(gate.classifyExplicitReply('haan bhej do'), 'confirm');
  assert.equal(gate.classifyExplicitReply("ok, don't send it yet"), 'cancel');
  assert.equal(gate.classifyExplicitReply('no'), 'cancel');
  assert.equal(gate.classifyExplicitReply('edit the subject'), 'edit');
  assert.equal(gate.classifyExplicitReply('great'), 'unknown');
  assert.equal(gate.classifyExplicitReply('perfect'), 'unknown');
  assert.equal(gate.classifyExplicitReply('done'), 'unknown');
});

test('every risky atomic tool declares centralized or workflow confirmation', () => {
  assert.equal(confirmationModeForTool('cancel_reminder', { query: 'visa docs' }), 'central');
  assert.equal(confirmationModeForTool('manage_sales', { action: 'delete', lead_name: 'Acme' }), 'central');
  assert.equal(confirmationModeForTool('manage_tasks', { action: 'assign', task_title: 'Review', assignee_name: 'Priya' }), 'central');
  assert.equal(confirmationModeForTool('send_email', {
    recipients: ['sam@example.com'], body: 'Hello',
  }), 'workflow');
  assert.equal(confirmationModeForTool('reschedule_calendar_event', {
    event: 'evt_123', new_start_time: '2026-07-20T10:00:00+05:30',
  }), 'workflow');
  assert.equal(confirmationModeForTool('view_calendar', {}), 'none');
});

test('central confirmation preview is bounded and names the exact action fields', () => {
  const preview = renderConfirmationPreview('manage_sales', {
    action: 'delete', lead_name: 'Acme',
  });
  assert.match(preview, /manage sales/i);
  assert.match(preview, /action: delete/i);
  assert.match(preview, /lead name: Acme/i);
  assert.ok(preview.length <= 1200);
});

test('leave approval reply cannot mutate a newest request without active context', async (t) => {
  const controller = require('../src/controllers/webhook.controller');
  const userPhone = '919999999904';
  controller.leaveConfirmContext.delete(userPhone);
  const original = controller.handleLeaveManage;
  let fallbackCalls = 0;
  controller.handleLeaveManage = async () => { fallbackCalls += 1; return 'unsafe fallback'; };
  t.after(() => { controller.handleLeaveManage = original; });

  const result = await controller.executeIntent(
    'leave_approval',
    { decision: 'approve' },
    { from: userPhone, text: 'approve' },
    { userTimezone: 'Asia/Kolkata' },
  );

  assert.equal(result.status, 'waiting_input');
  assert.match(result.user_summary, /no active leave request/i);
  assert.equal(fallbackCalls, 0);
});

test('email confirmation cannot send on praise and requires an explicit yes', async (t) => {
  const controller = require('../src/controllers/webhook.controller');
  const gmail = require('../src/services/gmail.service');
  const originals = {
    sendEmail: gmail.sendEmail,
    bodyToHtml: gmail.bodyToHtml,
  };
  t.after(() => {
    gmail.sendEmail = originals.sendEmail;
    gmail.bodyToHtml = originals.bodyToHtml;
  });

  let sent = 0;
  gmail.bodyToHtml = (body) => `<p>${body}</p>`;
  gmail.sendEmail = async () => { sent++; return { success: true }; };
  const ctx = {
    type: 'email_send_confirm',
    draft: { to: 'sam@example.com', subject: 'Launch', body: 'Ready.' },
    timestamp: Date.now(),
  };

  const ambiguous = await controller.handleCalendarConfirmation(
    { from: '919999999905', text: 'great' },
    ctx,
  );
  assert.equal(sent, 0);
  assert.match(ambiguous, /reply \*yes\*/i);

  const confirmed = await controller.handleCalendarConfirmation(
    { from: '919999999905', text: 'yes, send it' },
    { ...ctx, timestamp: Date.now() },
  );
  assert.equal(sent, 1);
  assert.match(confirmed, /email sent/i);
});

test('confirmed agent-tool actions render user_summary, never [object Object]', async () => {
  const userPhone = '918888800001';
  await gate.pend(userPhone, {
    actionType: 'agent_tool:manage_contact_groups',
    summary: 'Delete the group "Q3 Prospects" (12 members).',
    ctx: { toolName: 'manage_contact_groups', effect: 'destructive', runtime: 'test' },
    execute: async () => ({
      status: 'success',
      user_summary: 'Deleted the group "Q3 Prospects".',
      data: { deleted: true, group: 'Q3 Prospects' },
    }),
  });

  const reply = await gate.tryResolve(userPhone, 'yes');
  assert.equal(typeof reply, 'string');
  assert.ok(!reply.includes('[object Object]'), reply);
  assert.match(reply, /Deleted the group "Q3 Prospects"\./);
});

test('confirmed actions that resolve with a string still pass through unchanged', async () => {
  const userPhone = '918888800002';
  await gate.pend(userPhone, {
    actionType: 'agent_tool:cancel_reminder',
    summary: 'Cancel reminder #4.',
    ctx: { toolName: 'cancel_reminder', effect: 'destructive', runtime: 'test' },
    execute: async () => 'Reminder cancelled.',
  });

  const reply = await gate.tryResolve(userPhone, 'yes');
  assert.equal(reply, 'Reminder cancelled.');
});
