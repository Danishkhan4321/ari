'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeToolResult,
  serializeToolResult,
} = require('../src/services/tool-result.service');

test('normalizes a legacy user-facing string into a typed success result', () => {
  const result = normalizeToolResult('Reminder set for 5pm.', { toolName: 'set_reminder' });

  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'set_reminder');
  assert.equal(result.user_summary, 'Reminder set for 5pm.');
  assert.equal(result.error, null);
});

test('normalizes a legacy failure string into a typed non-retryable error', () => {
  const result = normalizeToolResult('Could not create the reminder: invalid time.', {
    toolName: 'set_reminder',
  });

  assert.equal(result.status, 'failure');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'legacy_tool_error');
  assert.equal(result.error.category, 'business_rule');
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /invalid time/i);
});

test('normalizes success:false legacy objects as failures', () => {
  const result = normalizeToolResult({ success: false, message: 'CRM write was rejected' }, { toolName: 'manage_sales' });
  assert.equal(result.status, 'failure');
  assert.equal(result.ok, false);
  assert.equal(result.user_summary, 'CRM write was rejected');
});

test('normalizes common validation and integration strings as failures', () => {
  for (const message of [
    'Invalid number. Choose between 1 and 3.',
    'Google integration is not configured on this server.',
    '⚠️ That meeting time is already in the past. Did you mean tomorrow?',
    'No recent email list. Check the inbox first.',
    'Lead "Missing Co" not found.',
    '❌ Something went wrong with incident management. Please try again.',
    '⚠️ You need to be part of a team to use the knowledge base.',
    '⛔ Failed to update the CRM record.',
  ]) {
    assert.equal(normalizeToolResult(message, { toolName: 'probe' }).status, 'failure', message);
  }
  assert.equal(normalizeToolResult('No reminders yet.', { toolName: 'view_reminders' }).status, 'success');
});

test('blank legacy output is unverified failure, never success', () => {
  const result = normalizeToolResult('   ', { toolName: 'manage_sales' });
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'empty_tool_result');
});

test('preserves an explicitly structured partial result', () => {
  const result = normalizeToolResult({
    status: 'partial',
    data: { completed: 2, remaining: 1 },
    error: { code: 'rate_limit', category: 'transient', retryable: true, message: 'Try later' },
    user_summary: 'Completed 2 of 3 follow-ups.',
  }, { toolName: 'bulk_email' });

  assert.equal(result.status, 'partial');
  assert.equal(result.ok, false);
  assert.deepEqual(result.data, { completed: 2, remaining: 1 });
  assert.equal(result.error.retryable, true);
  assert.equal(result.user_summary, 'Completed 2 of 3 follow-ups.');
});

test('serialized tool results are bounded without losing their status', () => {
  const serialized = serializeToolResult(normalizeToolResult({
    ok: true,
    result: 'x'.repeat(6000),
  }, { toolName: 'large_result' }), 1000);
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.status, 'success');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meta.truncated, true);
  assert.ok(serialized.length < 1400);
});
